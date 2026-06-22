import * as vscode from "vscode";
import * as http from "node:http";
import * as https from "node:https";

const SECRET_KEY = "cfAccessProxy.clientSecret";
const CONFIG_SECTION = "cfAccessProxy";

// Hop-by-hop headers that MUST NOT be forwarded (RFC 7230 §6.1 plus a few that
// http.createServer / https.request manage themselves).
const HOP_BY_HOP = new Set<string>([
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
]);

interface ProxyConfig {
    host: string;
    port: number;
    clientId: string;
    enable: boolean;
    disableThinking: boolean;
    stripEmptyToolCalls: boolean;
}

let server: http.Server | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let currentConfig: ProxyConfig | undefined;

function readConfig(): ProxyConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        host: (cfg.get<string>("host") ?? "").trim(),
        port: cfg.get<number>("port") ?? 8787,
        clientId: (cfg.get<string>("clientId") ?? "").trim(),
        enable: cfg.get<boolean>("enable") ?? true,
        disableThinking: cfg.get<boolean>("disableThinking") ?? true,
        stripEmptyToolCalls: cfg.get<boolean>("stripEmptyToolCalls") ?? true,
    };
}

// vLLM emits `delta.tool_calls: []` (empty array) alongside text content when
// the request carries a `tools` array. Strict OpenAI clients see the presence
// of `tool_calls` and interpret the delta as a tool-call message, ignoring the
// `content` field on the same delta — Copilot Chat then reports "no response
// was returned". Stripping the empty array restores the spec shape; non-empty
// arrays (real tool calls) pass through untouched.
function stripEmptyToolCallsInPlace(obj: any): boolean {
    let changed = false;
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.choices)) {
        return changed;
    }
    for (const ch of obj.choices) {
        if (
            ch &&
            ch.delta &&
            Array.isArray(ch.delta.tool_calls) &&
            ch.delta.tool_calls.length === 0
        ) {
            delete ch.delta.tool_calls;
            changed = true;
        }
        if (
            ch &&
            ch.message &&
            Array.isArray(ch.message.tool_calls) &&
            ch.message.tool_calls.length === 0
        ) {
            delete ch.message.tool_calls;
            changed = true;
        }
    }
    return changed;
}

// Rewrite a single SSE event (the text between two `\n\n` boundaries).
// Returns the (possibly modified) event text without the boundary.
function transformSseEvent(eventText: string): { out: string; stripped: boolean } {
    const lines = eventText.split("\n");
    const out: string[] = [];
    let stripped = false;
    for (const line of lines) {
        if (!line.startsWith("data: ")) {
            out.push(line);
            continue;
        }
        const data = line.slice(6);
        if (data === "[DONE]" || data === "") {
            out.push(line);
            continue;
        }
        try {
            const obj = JSON.parse(data);
            if (stripEmptyToolCallsInPlace(obj)) {
                stripped = true;
            }
            out.push("data: " + JSON.stringify(obj));
        } catch {
            out.push(line);
        }
    }
    return { out: out.join("\n"), stripped };
}

// Reasoning models split their stream into a long burst of
// `delta.reasoning_content` chunks followed by a final `delta.content` chunk.
// Strict OpenAI-spec clients (Copilot Chat, etc.) ignore reasoning_content and
// conclude "no response" before the content chunk arrives.
//
// Different backends honor different fields to disable thinking. We inject
// both — each backend ignores the field it doesn't know:
//   - vLLM (Qwen3, DeepSeek-V4/R1): chat_template_kwargs.enable_thinking
//   - Ollama (0.3.x+ for Qwen3, DeepSeek-R1, etc.): top-level `think`
//
// Only injected when:
//   - the path ends with /chat/completions
//   - the body parses as JSON
//   - the caller hasn't already set the corresponding field
// On any parse failure we return the original buffer untouched.
function maybeRewriteChatBody(
    path: string,
    method: string,
    body: Buffer,
): { body: Buffer; injectedVllm: boolean; injectedOllama: boolean } {
    const unchanged = {
        body,
        injectedVllm: false,
        injectedOllama: false,
    };
    if (method !== "POST") {
        return unchanged;
    }
    const p = path.split("?")[0];
    if (!p.endsWith("/chat/completions")) {
        return unchanged;
    }
    let obj: any;
    try {
        obj = JSON.parse(body.toString("utf8"));
    } catch {
        return unchanged;
    }
    if (!obj || typeof obj !== "object") {
        return unchanged;
    }

    let injectedVllm = false;
    let injectedOllama = false;

    // vLLM-shaped injection.
    const kwargs =
        obj.chat_template_kwargs && typeof obj.chat_template_kwargs === "object"
            ? obj.chat_template_kwargs
            : null;
    if (
        kwargs === null ||
        !Object.prototype.hasOwnProperty.call(kwargs, "enable_thinking")
    ) {
        if (kwargs === null) {
            obj.chat_template_kwargs = { enable_thinking: false };
        } else {
            kwargs.enable_thinking = false;
        }
        injectedVllm = true;
    }

    // Ollama-shaped injection.
    if (!Object.prototype.hasOwnProperty.call(obj, "think")) {
        obj.think = false;
        injectedOllama = true;
    }

    if (!injectedVllm && !injectedOllama) {
        return unchanged;
    }
    return {
        body: Buffer.from(JSON.stringify(obj), "utf8"),
        injectedVllm,
        injectedOllama,
    };
}

function log(msg: string): void {
    if (!output) {
        return;
    }
    const ts = new Date().toISOString();
    output.appendLine(`[${ts}] ${msg}`);
}

function updateStatusBar(): void {
    if (!statusBar) {
        return;
    }
    if (server && currentConfig) {
        statusBar.text = `$(check) CF Proxy :${currentConfig.port}`;
        statusBar.tooltip = `Forwarding 127.0.0.1:${currentConfig.port} -> https://${currentConfig.host}`;
    } else {
        // Distinguish "user disabled it / configured but stopped" from
        // "never been configured." Helps the user know what to do next
        // without opening Output.
        const cfg = currentConfig ?? readConfig();
        if (!cfg.clientId) {
            statusBar.text = "$(gear) CF Proxy: not configured";
            statusBar.tooltip =
                "Click for details. Set cfAccessProxy.clientId in Settings and run \"CF Access Proxy: Set Client Secret\" to start.";
        } else {
            statusBar.text = "$(circle-slash) CF Proxy: stopped";
            statusBar.tooltip = "CF Access Proxy is not running. Click for details.";
        }
    }
    statusBar.show();
}

function stopServer(): Promise<void> {
    return new Promise((resolve) => {
        if (!server) {
            resolve();
            return;
        }
        const s = server;
        server = undefined;
        s.close(() => {
            log("listener stopped");
            updateStatusBar();
            resolve();
        });
        // close() only stops accepting new connections; nudge any keep-alive
        // sockets so we don't hang on restart.
        // @ts-ignore - closeAllConnections exists on Node 18.2+ http.Server
        if (typeof s.closeAllConnections === "function") {
            // @ts-ignore
            s.closeAllConnections();
        }
    });
}

// `interactive` controls whether missing-config conditions surface as
// popups. The flag exists so the extension stays silent on initial
// install (activation triggered automatically by VS Code) — and only
// nudges the user when they explicitly ask to start/restart the proxy.
// Missing-config details always land in the Output channel + status bar
// regardless of the flag.
async function startServer(
    ctx: vscode.ExtensionContext,
    interactive: boolean,
): Promise<void> {
    const cfg = readConfig();
    currentConfig = cfg;

    const notConfigured = (msg: string) => {
        log("not starting: " + msg);
        if (interactive) {
            vscode.window.showWarningMessage("CF Access Proxy: " + msg);
        }
        updateStatusBar();
    };

    if (!cfg.enable) {
        notConfigured(
            "disabled (cfAccessProxy.enable = false). Set it to true to start.",
        );
        return;
    }
    if (!cfg.clientId) {
        notConfigured(
            'cfAccessProxy.clientId is not set. Add it in Settings, then run "CF Access Proxy: Restart".',
        );
        return;
    }
    if (!cfg.host) {
        notConfigured(
            'cfAccessProxy.host is not set. Add it in Settings, then run "CF Access Proxy: Restart".',
        );
        return;
    }

    const secret = await ctx.secrets.get(SECRET_KEY);
    if (!secret) {
        notConfigured(
            'client secret is not set. Run "CF Access Proxy: Set Client Secret" from the command palette.',
        );
        return;
    }

    const upstreamHost = cfg.host;
    const clientId = cfg.clientId;

    const disableThinking = cfg.disableThinking;
    const stripEmptyToolCalls = cfg.stripEmptyToolCalls;

    const srv = http.createServer((req, res) => {
        const method = req.method ?? "GET";
        const path = req.url ?? "/";

        // Clone + sanitize headers.
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (v === undefined) {
                continue;
            }
            if (HOP_BY_HOP.has(k.toLowerCase())) {
                continue;
            }
            outHeaders[k] = v as string | string[];
        }
        outHeaders["host"] = upstreamHost;
        outHeaders["CF-Access-Client-Id"] = clientId;
        outHeaders["CF-Access-Client-Secret"] = secret;

        const isChatCompletions =
            method === "POST" &&
            (path.split("?")[0]).endsWith("/chat/completions");

        const shouldRewriteRequest = disableThinking && isChatCompletions;
        const shouldRewriteResponse =
            stripEmptyToolCalls && isChatCompletions;

        // If we'll mutate the response body, ask upstream for identity encoding
        // so we aren't fighting gzip in the middle of the pipe.
        if (shouldRewriteResponse) {
            outHeaders["accept-encoding"] = "identity";
        }

        const handleUpstreamResponse = (
            upstreamRes: http.IncomingMessage,
        ) => {
            log(`${method} ${path} -> ${upstreamRes.statusCode ?? "?"}`);

            const contentType = (
                (upstreamRes.headers["content-type"] as string) || ""
            ).toLowerCase();

            if (
                shouldRewriteResponse &&
                contentType.includes("text/event-stream")
            ) {
                // SSE: rewrite per-event. content-length is absent (chunked),
                // so we just forward headers and stream-transform.
                res.writeHead(
                    upstreamRes.statusCode ?? 502,
                    upstreamRes.statusMessage,
                    upstreamRes.headers,
                );
                let buf = "";
                let strippedAny = false;
                upstreamRes.setEncoding("utf8");
                upstreamRes.on("data", (chunk: string) => {
                    buf += chunk;
                    let idx: number;
                    while ((idx = buf.indexOf("\n\n")) >= 0) {
                        const event = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        const t = transformSseEvent(event);
                        if (t.stripped) {
                            strippedAny = true;
                        }
                        res.write(t.out + "\n\n");
                    }
                });
                upstreamRes.on("end", () => {
                    if (buf.length) {
                        res.write(buf);
                    }
                    if (strippedAny) {
                        log(`stripped empty tool_calls on ${path} (SSE)`);
                    }
                    res.end();
                });
                upstreamRes.on("error", (err) => {
                    log(`upstream response error: ${err.message}`);
                    try {
                        res.end();
                    } catch {
                        // socket already gone
                    }
                });
            } else if (
                shouldRewriteResponse &&
                contentType.includes("application/json")
            ) {
                // Non-stream: buffer, parse, mutate, write with new CL.
                const bodyChunks: Buffer[] = [];
                upstreamRes.on("data", (c: Buffer | string) => {
                    bodyChunks.push(
                        Buffer.isBuffer(c) ? c : Buffer.from(c),
                    );
                });
                upstreamRes.on("end", () => {
                    const original = Buffer.concat(bodyChunks);
                    let outBody = original;
                    let stripped = false;
                    try {
                        const obj = JSON.parse(original.toString("utf8"));
                        if (stripEmptyToolCallsInPlace(obj)) {
                            stripped = true;
                            outBody = Buffer.from(
                                JSON.stringify(obj),
                                "utf8",
                            );
                        }
                    } catch {
                        // pass through unchanged
                    }
                    const responseHeaders: http.OutgoingHttpHeaders = {
                        ...upstreamRes.headers,
                    };
                    responseHeaders["content-length"] = String(outBody.length);
                    res.writeHead(
                        upstreamRes.statusCode ?? 502,
                        upstreamRes.statusMessage,
                        responseHeaders,
                    );
                    if (stripped) {
                        log(
                            `stripped empty tool_calls on ${path} (JSON, ${original.length}->${outBody.length} bytes)`,
                        );
                    }
                    res.end(outBody);
                });
                upstreamRes.on("error", (err) => {
                    log(`upstream response error: ${err.message}`);
                    try {
                        res.end();
                    } catch {
                        // socket already gone
                    }
                });
            } else {
                // Pass through unmodified.
                res.writeHead(
                    upstreamRes.statusCode ?? 502,
                    upstreamRes.statusMessage,
                    upstreamRes.headers,
                );
                upstreamRes.pipe(res);
            }
        };

        const openUpstream = (bodyOrNull: Buffer | null) => {
            const upstream = https.request(
                {
                    host: upstreamHost,
                    port: 443,
                    method,
                    path,
                    headers: outHeaders,
                },
                handleUpstreamResponse,
            );

            upstream.on("error", (err) => {
                log(`upstream error for ${method} ${path}: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(502, { "content-type": "text/plain" });
                }
                try {
                    res.end(`upstream error: ${err.message}`);
                } catch {
                    // socket already gone; nothing to do
                }
            });

            req.on("aborted", () => {
                upstream.destroy();
            });
            req.on("error", (err) => {
                log(`client request error: ${err.message}`);
                upstream.destroy();
            });

            if (bodyOrNull === null) {
                req.pipe(upstream);
            } else {
                upstream.end(bodyOrNull);
            }
        };

        if (shouldRewriteRequest) {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer | string) => {
                chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
            });
            req.on("end", () => {
                const original = Buffer.concat(chunks);
                const r = maybeRewriteChatBody(path, method, original);
                outHeaders["content-length"] = String(r.body.length);
                if (r.injectedVllm || r.injectedOllama) {
                    const fields: string[] = [];
                    if (r.injectedVllm) {
                        fields.push(
                            "chat_template_kwargs.enable_thinking=false",
                        );
                    }
                    if (r.injectedOllama) {
                        fields.push("think=false");
                    }
                    log(
                        `injected ${fields.join(" + ")} on ${path} (${original.length}->${r.body.length} bytes)`,
                    );
                }
                openUpstream(r.body);
            });
            req.on("error", (err) => {
                log(`client request error during buffering: ${err.message}`);
            });
        } else {
            openUpstream(null);
        }
    });

    srv.on("error", (err) => {
        log(`server error: ${err.message}`);
        vscode.window.showErrorMessage(`CF Access Proxy: ${err.message}`);
        server = undefined;
        updateStatusBar();
    });

    await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => {
            srv.removeListener("listening", onOk);
            reject(err);
        };
        const onOk = () => {
            srv.removeListener("error", onErr);
            resolve();
        };
        srv.once("error", onErr);
        srv.once("listening", onOk);
        srv.listen(cfg.port, "127.0.0.1");
    }).catch((err: Error) => {
        log(`failed to bind 127.0.0.1:${cfg.port}: ${err.message}`);
        vscode.window.showErrorMessage(
            `CF Access Proxy: failed to bind 127.0.0.1:${cfg.port}: ${err.message}`,
        );
        return undefined;
    });

    if (!srv.listening) {
        updateStatusBar();
        return;
    }

    server = srv;
    log(`listening on 127.0.0.1:${cfg.port} -> https://${upstreamHost}`);
    updateStatusBar();
}

async function restart(
    ctx: vscode.ExtensionContext,
    interactive: boolean,
): Promise<void> {
    log("restart requested");
    await stopServer();
    await startServer(ctx, interactive);
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel("CF Access Proxy");
    ctx.subscriptions.push(output);
    log("extension activating");

    statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        0,
    );
    statusBar.command = "cfAccessProxy.status";
    ctx.subscriptions.push(statusBar);
    updateStatusBar();

    ctx.subscriptions.push(
        vscode.commands.registerCommand("cfAccessProxy.setSecret", async () => {
            const raw = await vscode.window.showInputBox({
                prompt: "CF Access Client Secret",
                password: true,
                ignoreFocusOut: true,
                placeHolder: "paste the service-token client secret",
            });
            if (raw === undefined) {
                return; // cancelled
            }
            // Defensive: paste from a JSON value or a terminal selection often
            // carries trailing whitespace/newlines or surrounding quotes. CF
            // Access rejects any of those, and the failure is opaque (just 403).
            const value = raw.trim().replace(/^["']|["']$/g, "").trim();
            if (!value) {
                vscode.window.showWarningMessage(
                    "CF Access Proxy: empty secret not stored. Use the Clear command to remove an existing secret.",
                );
                return;
            }
            await ctx.secrets.store(SECRET_KEY, value);
            vscode.window.showInformationMessage(
                "CF Access Proxy: client secret stored. Restarting listener.",
            );
            // secrets.onDidChange will fire the restart.
        }),
        vscode.commands.registerCommand("cfAccessProxy.clearSecret", async () => {
            await ctx.secrets.delete(SECRET_KEY);
            vscode.window.showInformationMessage(
                "CF Access Proxy: client secret cleared.",
            );
        }),
        vscode.commands.registerCommand("cfAccessProxy.restart", async () => {
            await restart(ctx, /* interactive */ true);
            vscode.window.showInformationMessage(
                server
                    ? `CF Access Proxy: listening on 127.0.0.1:${currentConfig?.port}.`
                    : "CF Access Proxy: not listening (see Output: CF Access Proxy).",
            );
        }),
        vscode.commands.registerCommand("cfAccessProxy.status", async () => {
            const cfg = currentConfig ?? readConfig();
            const secretSet = !!(await ctx.secrets.get(SECRET_KEY));
            if (server) {
                vscode.window.showInformationMessage(
                    `CF Access Proxy: listening on 127.0.0.1:${cfg.port} -> https://${cfg.host}.`,
                );
                return;
            }
            const missing: string[] = [];
            if (!cfg.clientId) {
                missing.push("cfAccessProxy.clientId (Settings)");
            }
            if (!cfg.host) {
                missing.push("cfAccessProxy.host (Settings)");
            }
            if (!secretSet) {
                missing.push("client secret (run \"CF Access Proxy: Set Client Secret\")");
            }
            if (!cfg.enable) {
                missing.push("cfAccessProxy.enable (Settings — currently false)");
            }
            if (missing.length === 0) {
                vscode.window.showInformationMessage(
                    "CF Access Proxy: stopped. Run \"CF Access Proxy: Restart\" to start the listener.",
                );
            } else {
                vscode.window.showInformationMessage(
                    `CF Access Proxy: not configured. Missing: ${missing.join("; ")}.`,
                );
            }
        }),
    );

    ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                log("configuration changed; restarting");
                // User just edited a setting — they're paying attention.
                // Surface missing-config issues as popups.
                void restart(ctx, /* interactive */ true);
            }
        }),
    );

    ctx.subscriptions.push(
        ctx.secrets.onDidChange((e) => {
            if (e.key === SECRET_KEY) {
                log("client secret changed; restarting");
                // The secret was just set/cleared via a command — also a
                // moment of user attention.
                void restart(ctx, /* interactive */ true);
            }
        }),
    );

    ctx.subscriptions.push({
        dispose: () => {
            void stopServer();
        },
    });

    // Activation is automatic on VS Code startup. Stay silent on missing
    // config — the status bar carries the state and the user can click it
    // (or run "Show Status") when they're ready to configure.
    await startServer(ctx, /* interactive */ false);
}

export async function deactivate(): Promise<void> {
    await stopServer();
}

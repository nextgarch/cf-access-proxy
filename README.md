# Cloudflare Access Proxy (VS Code extension)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nextgarch.cf-access-proxy?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=nextgarch.cf-access-proxy)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/nextgarch.cf-access-proxy)](https://marketplace.visualstudio.com/items?itemName=nextgarch.cf-access-proxy)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A tiny local HTTP forward-proxy that injects `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers on every outgoing request. It exists for one
specific situation:

- You have an OpenAI-compatible endpoint sitting behind Cloudflare Access
  (service-token gated).
- You want a VS Code chat extension to talk to it.
- The chat extension lets you change the OpenAI base URL but does **not** let
  you add custom HTTP headers.

This extension runs `http://127.0.0.1:<port>` inside VS Code, transparently
forwards every request to `https://<your-upstream>:443` with the right CF
Access headers attached, and pipes the response back. Auto-starts when VS Code
launches.

Includes default-on compatibility shims that make reasoning models (vLLM
with Qwen3 / DeepSeek-V4/R1; Ollama 0.3.x+) work cleanly with strict OpenAI
clients like Copilot Chat — see *vLLM reasoning-model compatibility* below.

## Build

Requires Node 18+ and npm.

```sh
npm install
npm run package
```

That produces `cf-access-proxy-<version>.vsix` in the project root.

## Install

Local VS Code:

```sh
code --install-extension cf-access-proxy-<version>.vsix
```

Remote-SSH host (install into the remote, not your local UI):

```sh
code --install-extension cf-access-proxy-<version>.vsix --remote ssh-remote+<hostname>
```

Or, with VS Code already attached to the remote, open the Extensions panel and
drag-drop the `.vsix` onto it.

## Configure

In Settings UI (search "CF Access Proxy") or `settings.json`:

```jsonc
{
  "cfAccessProxy.host": "api.nextgarch.org",
  "cfAccessProxy.port": 8787,
  "cfAccessProxy.clientId": "abc123def456.access",
  "cfAccessProxy.enable": true,

  // Reasoning-model compatibility shims (both default true; turn off only if
  // your upstream is a non-reasoning OpenAI-compatible API).
  "cfAccessProxy.disableThinking": true,
  "cfAccessProxy.stripEmptyToolCalls": true
}
```

Then run **CF Access Proxy: Set Client Secret** from the command palette
(`Ctrl+Shift+P`) and paste the matching service-token secret. The proxy
restarts automatically when settings or the secret change.

Other commands:

- **CF Access Proxy: Show Status** — current host/port/state (also: click the
  status-bar entry "CF Proxy: :8787").
- **CF Access Proxy: Restart** — stop + start the listener.
- **CF Access Proxy: Clear Client Secret** — remove the stored secret.

Logs live in **Output > CF Access Proxy** (method/path/upstream status only;
no bodies or auth headers).

## Point your chat extension at the proxy

Use `http://127.0.0.1:8787/v1` (adjust port to match `cfAccessProxy.port`) as
the OpenAI base URL. Any path you hit on the proxy is forwarded verbatim to
the upstream, so `/v1/chat/completions`, `/v1/models`, etc. all work.

## vLLM reasoning-model compatibility

If your upstream is vLLM serving a reasoning model (DeepSeek-V4, Qwen3, R1
family) with `--reasoning-parser`, two response quirks break strict OpenAI
clients like Copilot Chat. Both default-on settings work around them:

- **`cfAccessProxy.disableThinking`** — when the request is a
  `POST /v1/chat/completions` and the caller hasn't set
  `chat_template_kwargs.enable_thinking`, the proxy injects
  `chat_template_kwargs.enable_thinking: false` into the body. Without this,
  vLLM emits a long burst of `delta.reasoning_content` chunks before the first
  `delta.content` chunk; Copilot ignores `reasoning_content` (it's not in the
  OpenAI spec), concludes the model produced nothing, and shows *"Sorry, no
  response was returned"*.

- **`cfAccessProxy.stripEmptyToolCalls`** — when the request carries a
  `tools: [...]` array, vLLM emits `delta.tool_calls: []` (an empty array)
  alongside the text content. Strict clients see the presence of `tool_calls`
  and treat the delta as a tool-call message, ignoring the `content` field on
  the same delta. The proxy removes the empty array from SSE deltas and
  non-stream message bodies. Real (non-empty) tool calls pass through.

Both are no-ops when the upstream is a stock OpenAI-compatible API, so you can
leave them on by default.

For Ollama users: `disableThinking` also injects top-level `think: false`, which
Ollama 0.3.x+ honors for its reasoning models (Qwen3, DeepSeek-R1, etc.). The
two injections coexist harmlessly — each backend ignores the field it doesn't
recognize.

## Security note

The client secret is stored in VS Code's `SecretStorage`, which is backed by
the OS keyring (Keychain on macOS, libsecret/kwallet on Linux, DPAPI on
Windows). It never lands in `settings.json` and is never written to logs.

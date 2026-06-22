# Changelog

All notable changes to **Cloudflare Access Proxy** are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.3] — 2026-06-22

### Changed

- **Marketplace identifier renamed** from `nextgarch.cf-access-proxy` to
  `nextgarch.cloudflare-access-proxy`. The old identifier was permanently
  reserved by Microsoft after the previous extension was unpublished
  (cleanup of a stale placeholder string in setting metadata), and that
  name cannot be re-published. The display name *Cloudflare Access Proxy*
  is unchanged, and so is the underlying code. If you had the old version
  installed (`nextgarch.cf-access-proxy`), please uninstall it and
  install the new identifier from the marketplace.

## [0.4.2] — 2026-06-22

### Changed

- **Silent activation when not configured.** On a fresh install the
  extension no longer surfaces popup warnings about missing settings.
  Configuration state is shown in the status bar — *"CF Proxy: not
  configured"* when `clientId` / secret aren't set, *"CF Proxy stopped"*
  when configured but not listening. Click the status bar (or run
  *CF Access Proxy: Show Status*) to see exactly what's missing.
- *CF Access Proxy: Show Status* now lists every missing piece in a
  single message instead of reporting just the first.
- Popups still appear when the user explicitly invokes
  *CF Access Proxy: Restart*, edits a `cfAccessProxy.*` setting, or
  changes the client secret — those are moments of user attention where
  surfacing the issue is helpful.

### Fixed

- Removed the prefix-of-a-real-client-ID from the `cfAccessProxy.clientId`
  description in `package.json`. The setting description now describes
  the value's shape generically rather than embedding a partial example.

## [0.4.1] — 2026-06-22

### Removed

- Custom icon. Falls back to the marketplace default. (No behavior change.)

## [0.4.0] — 2026-06-22

First public release on the VS Code Marketplace.

### Added

- Local HTTP forward proxy on `127.0.0.1:<port>` that injects
  `CF-Access-Client-Id` and `CF-Access-Client-Secret` service-token headers
  on every outgoing request, letting VS Code chat extensions (Copilot Chat,
  Continue, etc.) reach a Cloudflare-Access-gated OpenAI-compatible endpoint
  without needing custom-header support on the client side.
- Status bar item, dedicated **Output → CF Access Proxy** channel (method,
  path, upstream status only — never bodies or auth headers), and four
  commands: **Set Client Secret**, **Clear Client Secret**, **Restart**,
  **Show Status**.
- Client secret stored in VS Code `SecretStorage` (OS keyring), never in
  `settings.json`. Set/cleared via the command palette.
- `cfAccessProxy.disableThinking` (default on) — injects
  `chat_template_kwargs.enable_thinking=false` (vLLM convention, used by
  Qwen3 and DeepSeek-V4/R1) **and** top-level `think=false` (Ollama 0.3.x+
  convention) into chat-completion request bodies that don't already set
  them. Stops reasoning models from streaming `delta.reasoning_content`
  chunks that strict OpenAI clients ignore — fixes the *"Sorry, no response
  was returned"* failure mode in Copilot Chat.
- `cfAccessProxy.stripEmptyToolCalls` (default on) — strips empty
  `tool_calls: []` arrays from `/v1/chat/completions` response chunks (SSE
  delta and non-stream message). vLLM emits this empty array alongside text
  content when the request includes `tools`, and strict OpenAI clients treat
  any delta with a `tool_calls` field as a tool-call message, ignoring the
  text. Real (non-empty) tool calls pass through untouched.

### Security

- Logs include request method, path, and upstream HTTP status only.
  Authorization headers, CF Access secrets, request bodies, and response
  bodies are never logged.

[0.4.3]: https://github.com/nextgarch/cf-access-proxy/releases/tag/v0.4.3
[0.4.2]: https://github.com/nextgarch/cf-access-proxy/releases/tag/v0.4.2
[0.4.1]: https://github.com/nextgarch/cf-access-proxy/releases/tag/v0.4.1
[0.4.0]: https://github.com/nextgarch/cf-access-proxy/releases/tag/v0.4.0

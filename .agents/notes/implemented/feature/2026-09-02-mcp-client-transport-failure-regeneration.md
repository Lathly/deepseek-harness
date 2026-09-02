# Agent Note: MCP client Streamable HTTP bounded dispatcher and mid-call failure regeneration

Status: implemented

English | [中文](2026-09-02-mcp-client-transport-failure-regeneration.zh.md)

## Problem

Streamable HTTP rows ran their requests on Node's default undici fetch agent, whose header and body timeouts sit near 300 s. A long LLM-backed `tools/call` that sends no bytes until it finishes — memory operations that take 5–10 minutes in production — lost its socket to that default agent mid-call. The SDK's protocol-level `timeout` aborted the pending request, so the model saw a client-side `fetch failed` while the server kept working, and the transport's connection sat wedged: `onclose` never fired, the [auto-reconnect](2026-08-06-mcp-client-auto-reconnect.md) supervisor never saw a downed generation, and every later call on that generation failed with `fetch failed` until a human edited the config (an HMR reload rebuilt the connection) or restarted the Host. Production wedged twice within an hour on a single row.

## Decision

`packages/mcp/mcp-client/src/transport.ts` bounds the row's HTTP lifetime; `src/tools.ts` classifies which call failures are connection-level; `src/connection.ts` turns that report into the existing regeneration cycle.

**Bounded per-row dispatcher.** A streamable-http row constructs an undici `Agent` with `headersTimeout` and `bodyTimeout` equal to its `toolCallTimeoutMs` and injects it into the SDK transport through a bounded fetch wrapper: undici's own `fetch` with the dispatcher in the request init, because the web `fetch` rejects an external agent and the SDK's `FetchLike` seam is the only injection point that covers both request POSTs and the SSE stream. Every request on the row — `initialize`, `tools/list`, `tools/call`, the stream — now shares the row's budget, and a response that keeps trickling bytes stays alive. The row's `close` drains the dispatcher; a dispatcher that will not drain is swallowed, and process exit reclaims its sockets.

**Mid-call failure report.** `callToolUncached` catches the request rejection and, when the call was not aborted, reports it through the new optional `ToolBridgeOptions.onTransportFailure` only when the classifier names a network-level failure: the undici `fetch failed` wrapper, or a network-family error code (`UND_ERR*`, `ECONN*`, `ENET*`, `EHOST*`, `EPIPE`, `ETIMEDOUT`) anywhere in the cause chain. Protocol-level responses (`McpError`) and plain rejections are not connection failures; an aborted call is the harness's own decision. The supervisor's hook closes the live generation — a closing rejection is swallowed — so the transport's `onclose` drives the established `generationDown` → backoff → regeneration path. A report that arrives after the generation already closed is a no-op, and a hookless bridge (direct `syncTools` use) simply has no report target.

**No new configuration.** `toolCallTimeoutMs` was already the row's per-call budget; it now also bounds the row's idle waits, which is the behavior the name promised.

## Alternatives considered

**Protocol timeout only.** The SDK already aborted the pending request at `timeout`; that is what produced the wedge, because the request-level abort leaves the transport connection dead-but-open. Rejected as a standalone fix.

**Fallback timer for a missing `onclose`.** Rejected: the SDK transport fires `onclose` on every `close`, with or without an SSE stream, so the close signal already exists and a second silent-down detector would duplicate a bounded lifecycle.

**Process-wide dispatcher.** Rejected: the bound is per-row — different rows carry different `toolCallTimeoutMs` values — and a global agent would couple unrelated rows and every other fetch in the process.

**Web `fetch` with a custom dispatcher.** Rejected: the global fetch rejects an external undici agent, so the dispatcher applies only through undici's own `fetch`.

## Testing

Unit (`tests/transport-failure.spec.ts`, mocked SDK): a mid-call network failure closes the generation, reconnects, re-syncs, and serves the recovered call; protocol-level responses, plain rejections, and aborted calls do not regenerate; a closed generation no-ops the report; a rejecting close is swallowed while regeneration proceeds; a hookless bridge reports nowhere; and the classifier matrix covers the wrapper, the cause-chain codes, and the negatives. Real composition (`tests/streamable-http.spec.ts`, real SDK plus a local HTTP server on dynamic ports): a slow `tools/list` is rejected at the row budget instead of the runtime default, proving the dispatcher bound rather than a late response; a long call inside the budget succeeds; a server that dies mid-call yields an `isError` result, the report's warn line, and — after the server restarts on the same port — a reconnected and re-synced row; teardown drains the dispatcher's sockets.

## Consequences

- Long LLM-backed calls stay alive up to the row's budget; the silent 300 s socket cut is gone, and a mid-call network failure self-heals through the existing reconnect cycle instead of waiting on a config edit.
- `toolCallTimeoutMs` is now the row's complete HTTP time bound: a streaming response that overruns it mid-stream is cut off where the runtime default previously applied.
- `undici` becomes a direct package dependency, imported at runtime and external in the built bundle.
- The web `fetch`/Response boundary is crossed once, at the dispatcher injection point, with a cast documenting that the undici response satisfies the web response contract the SDK consumes.

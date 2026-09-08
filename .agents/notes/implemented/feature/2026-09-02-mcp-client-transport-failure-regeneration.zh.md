# Agent Note: MCP client Streamable HTTP bounded dispatcher and mid-call failure regeneration

Status: implemented

English | [中文](2026-09-02-mcp-client-transport-failure-regeneration.md)

## Problem

Streamable HTTP 行上的请求运行在 Node 默认的 undici fetch agent 上，其 header 与 body 超时间接近 300 s。长时间不返回字节、耗时数分钟的 LLM 型 `tools/call`（生产环境中记忆操作需 5–10 分钟）会在调用中途被该默认 agent 切断 socket。SDK 的协议级 `timeout` 会中止挂起请求，于是模型看到客户端侧的 `fetch failed`，而服务器仍在继续工作；transport 的连接则陷入卡死：`onclose` 永远不触发，[自动重连](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md)监督器从未观察到下线的代，该代上的后续每次调用都以 `fetch failed` 失败，直到人工编辑配置（HMR 重建连接）或重启 Host。生产环境在单个行上于 1 小时内卡死两次。

## Decision

`packages/mcp/mcp-client/src/transport.ts` 约束该行的 HTTP 生命周期；`src/tools.ts` 判别哪些调用失败属于连接级；`src/connection.ts` 将该上报转化为既有的再生循环。

**有界的每行 dispatcher。** streamable-http 行构造一个 undici `Agent`，其 `headersTimeout` 与 `bodyTimeout` 等于该行的 `toolCallTimeoutMs`，并通过有界 fetch 包装器注入 SDK transport：使用 undici 自己的 `fetch` 并在请求 init 中携带 dispatcher，因为 web `fetch` 拒绝外部 agent，而 SDK 的 `FetchLike` 接缝是唯一同时覆盖请求 POST 与 SSE 流的注入点。该行的每个请求——`initialize`、`tools/list`、`tools/call`、流——现在共享该行的预算，持续滴字节的响应可以保持存活。行的 `close` 会排空 dispatcher；无法排空的 dispatcher 予以吞没，进程退出时回收其 socket。

**调用中途失败上报。** `callToolUncached` 捕获请求拒绝，并在调用未被中止、且判别器认定为网络级失败时，通过新增的可选 `ToolBridgeOptions.onTransportFailure` 上报：undici 的 `fetch failed` 包装，或 cause 链任意位置上的网络族错误码（`UND_ERR*`、`ECONN*`、`ENET*`、`EHOST*`、`EPIPE`、`ETIMEDOUT`）。协议级响应（`McpError`）与普通拒绝不是连接失败；被中止的调用是 harness 自己的决定。监督器的钩子关闭存活的代——关闭的拒绝予以吞没——于是 transport 的 `onclose` 驱动既有的 `generationDown` → 退避 → 再生路径。代已关闭之后到达的上报是空操作，无钩子的 bridge（直接使用 `syncTools`）则没有上报目标。

**无新配置。** `toolCallTimeoutMs` 原本就是该行的逐调用预算；现在它也约束该行的空闲等待——这正是该名称所承诺的行为。

## Alternatives considered

**仅协议超时。** SDK 本就在 `timeout` 时中止挂起请求；而那正是卡死的成因，因为请求级中止让 transport 连接处于已死但未关闭的状态。作为单独修复被否决。

**缺失 `onclose` 的兜底定时器。** 否决：SDK transport 在每次 `close` 时都触发 `onclose`（无论有无 SSE 流），关闭信号本就存在，第二个静默下线检测器只会重复一个已有界的生命周期。

**进程级 dispatcher。** 否决：预算是每行独立的——不同行的 `toolCallTimeoutMs` 不同——全局 agent 会把无关的行以及进程内所有其他 fetch 耦合在一起。

**web `fetch` 加自定义 dispatcher。** 否决：全局 fetch 拒绝外部 undici agent，dispatcher 只有通过 undici 自己的 `fetch` 才能生效。

## Testing

单元（`tests/transport-failure.spec.ts`，mocked SDK）：调用中途的网络失败关闭代、重连、再同步并服务恢复后的调用；协议级响应、普通拒绝与中止调用不再生；已关闭的代对上报是空操作；拒绝的 close 被吞没且再生照常推进；无钩子 bridge 无处上报；判别器矩阵覆盖包装、cause 链错误码与各项否定情形。真实组合（`tests/streamable-http.spec.ts`，真实 SDK 加动态端口的本地 HTTP 服务器）：缓慢的 `tools/list` 在该行预算处被拒绝而非运行时默认值处，证明是 dispatcher 预算而非迟到的响应；预算内的长调用成功；调用中途死去的服务器产生 `isError` 结果、上报的 warn 行，并在服务器于同一端口重启后重连且再同步；teardown 排空 dispatcher 的 socket。

## Consequences

- 长 LLM 调用存活至该行预算为止；静默的 300 s socket 切断消失，调用中途的网络失败经由既有重连循环自愈，不再等待配置编辑。
- `toolCallTimeoutMs` 现在是该行完整的 HTTP 时间边界：超出它的流式响应在流中被切断，此前该处适用的是运行时默认值。
- `undici` 成为包的直接依赖，运行时导入且构建产物中保持外部化。
- web `fetch`/Response 边界在 dispatcher 注入点处跨越一次，并以注释文档化的 cast 表明 undici 响应满足 SDK 消费的 web 响应契约。

# Agent Note: 会话模型切换工具（list_models / switch_model）

Status: implemented

[English](2026-09-04-session-model-switch-tools.md) | 中文

## Problem

会话没有面向模型的方式改变自身运行的 LLM 路由。使用场景是带缓存模型上限的本地 router：为了给本地任务腾出 GPU 内存，agent 应自己切换到更轻或不同位置的模型，完成任务后再切回——并且它应先能发现可用的路由与当前默认值。在此之前，改路由意味着编辑配置或重启；一个会话本地的动态 Cordis 插件验证了面向模型的文本与 controller 契约，但它随每次进程重启消失，也无法随预设发布。

## Decision

`packages/llm/tool-model-switch` 在 `ctx.tools` 上注册两个工具：

- **`switch_model(provider, model, reasoningEffort?)`** 委托给 `sessionController` 服务的 `selectModel`：切换会追加一条持久的 `model/selection` 会话事件，并更新新会话的部署默认值，从 agent 的下一次模型请求生效。`reasoningEffort` 参数属于 adapter、可选；空字符串按省略处理。
- **`list_models`** 渲染 `sessionController` 的 `modelCatalog`：默认选择、带模型列表的提供方分组，以及目录加载失败的提供方。分组行仅在显示名与 id 不同时打印 `id (name):`。

controller 在调用时通过 `ctx.get('sessionController')` 惰性查找，因此该包在有任何 `tools` 的地方都能加载。在没有挂载会话控制器的部署（headless 或 SDK profile）中，两个工具在目录中保持可见，并在调用时以固定错误失败（`switch_model: the session controller is not available in this deployment`，以及 `list_models` 的对应版本），因此调用是发现该路由不可用的唯一方式。面向模型的描述、参数与结果文本逐字固定，来自已验证的会话本地插件。

这些工具是既有选择 seam 的面向模型消费者：[默认模型跟随选择器](2026-08-07-default-model-follows-the-picker.zh.md) 拥有 `agent-default-model` 持久化与 `model/selection` 事件，[Web 会话模型选择器](2026-07-24-web-session-model-selector.zh.md) 是同一偏好的用户界面编辑器；本注不引入新状态，只新增 `sessionController` 之上的工具面。

agent 预设（`standard`、`ptc`、`cordis`）在 `tool-web` 块之后挂载该包；`minimal` 保持干净。`sessionController` 服务仍是 host 面贡献（Web 面提供它），`packages/bundle/base` 携带新的依赖，使预设的 specifier 解析能找到该包。该包没有 `Config`；没有需要随部署变化的配置项。

## Alternatives considered

**保留动态 Cordis 插件作为机制。** 否决：会话本地、重启即失、需要逐会话审批，且无法出现在随产品发布的预设中，因此该行为永远无法成为默认。

**仅客户端 UI 操作，无模型工具。** 否决：切换决策属于模型（只有它知道自己即将运行本地任务）；仅 UI 的 seam 会让模型看不到可切换的路由。

**对 `sessionController` 使用硬 `inject`。** 否决：该包会在没有该服务的每个部署中等待或加载失败，把工具藏起来而非在调用时响亮失败。惰性 `ctx.get` 保持加载无条件，并把固定错误推迟到首次调用。

**在 host 组合中挂载而非预设。** 否决：这些工具是逐会话贡献，其 `switch_model` 调用需要一个调用方 Agent 会话；agent 预设拥有逐会话工具注册表。

## Testing

单元（`packages/llm/tool-model-switch/tests/tool-model-switch.spec.ts`）：注册面（两个工具名、投影的对象 schema 与顶层 `required` 数组、`presentCall` 视图）、通过 fiber 销毁验证的 HMR 安全性、`switch_model` 路径（普通、带 effort、空字符串 effort 省略、缺 agent 上下文、缺 controller、controller 拒绝传播），以及 `list_models` 渲染（默认行、分组行不对称、模型描述行、目录失败行、缺 controller）。真实组合（`tests/loader-composition.spec.ts`）通过真实 Cordis Loader 启动临时 `cordis.yml`，挂载 `dsh-agent`、`dsh-system-prompt`、`dsh-tools` 与该包，经 `ctx.provide` 提供 mock 的 `sessionController`，通过真实注册表执行两个工具，断言归一化请求、渲染结果与无 controller 组合中的调用时失败。包源码的逐文件覆盖率为 100%。快照语料对新工具零引用，录制会话车道不受影响。

## Consequences

- 模型可以在会话中途重新路由自身；切换是持久的（会话事件），通过[既有持久化 seam](2026-08-07-default-model-follows-the-picker.zh.md)移动部署默认值，从下一次模型请求生效。在带缓存模型上限的 router 上，切换调用本身很快，模型加载是惰性的、发生在下一次请求。
- standard、ptc 与 cordis 预设目录各新增两个 schema（一个三属性对象与一个空对象），在这些预设中是一笔小额固定 token 成本。
- headless 与 SDK 部署会看到这两个工具，并得到固定的调用时错误，而非隐藏的能力。
- 验证文本的会话本地动态插件自此冗余；在永久路径于实机实例验证后可退役。

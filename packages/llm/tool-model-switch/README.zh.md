---
description: "面向模型的 switch_model 与 list_models 工具，经由会话控制器的 LLM 路由实现，供选择、配置或调试会话模型路由的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-model-switch

[English](README.md) | 中文

## 概述

`dsh-tool-model-switch` 为 agent 提供两个用于切换自身模型路由的工具：`switch_model` 将发起会话切换到另一个 provider/模型路由，`list_models` 报告该部署可以服务的路由。切换从会话的下一个模型请求开始生效，记录在会话日志中，并同步移动新会话启动所用的部署默认值。在任意 agent 预设中挂载该包即可；在没有会话控制器的部署中，工具保持可见，并在调用时以固定错误失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 需要在运行时自主选择模型路由时使用本包——例如为本地任务腾出 GPU 显存而切换到更轻的模型，完成后切回。在 agent 预设中挂载该包，agent 即获得两个工具；不存在任何配置。agent 被期望先调用 `list_models`，再用其中读到的路由调用 `switch_model`。

### 何时选择

- 部署提供不止一条模型路由（多个 provider，或同一 provider 上的多个模型），且 agent 需要在它们之间移动。
- 会话应拥有自己的路由：切换记录在其日志中，并在恢复时重放。

### 何时不选择

- 部署只有一条路由；工具会报告它，但切换没有别处可去。
- 部署没有挂载会话控制器（headless、SDK）：调用以固定错误失败，这是该模式下路由不可用的唯一信号。

<a id="understand-the-implementation"></a>
## 理解实现

该包是一个函数插件，在 `ctx.tools` 上注册两个工具，仅注入工具注册表。每次执行通过 `ctx.get` 惰性查找可选的 `sessionController` 服务，因此挂载该包永远不会阻塞在该服务上：没有该服务的部署只是在调用时让相应调用失败。`switch_model` 将参数归一化为一个 `selectModel` 请求——空字符串的 `reasoning_effort` 被省略，使 provider 默认值生效——并把控制器归一化后的选择渲染回模型。`list_models` 渲染控制器的目录：默认选择、每个可路由 provider 组及其模型、以及孤立的 provider 失败。

两个工具都是会话贡献，因此该包从 agent 预设而非宿主组合挂载。`sessionController` 服务本身留在宿主平面，由 Web 表面提供。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`switch_model` 与 `list_models` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-model-switch)：`switch_model` 接受必填的 `provider` 与 `model` 路由 id 及可选的 `reasoning_effort`，`list_models` 不接受参数。

#### Token 影响

在工具可见的每个请求上产生固定 schema 开销；描述与 schema 对给定部署保持稳定。

#### KV Cache 影响

在工具定义不变时前缀稳定。插件生命周期或作用域限制可能使来自这些 schema 的复用失效。

### 工具调用历史与结果

#### 模型看到什么

每个 `switch_model` 调用保留其路由参数。成功时恰好返回 `Switched this session's model to <provider>/<model>`，当控制器回显 effort 时附加 ` (reasoning effort <effort>)`，以 `Effective from the next model request; the default for new sessions now matches this selection.` 收尾。`list_models` 返回默认路由、每个 provider 组一行、每个模型一行、每个失败 provider 一行，以换行连接。稳定失败为 `switch_model: no agent context for this call`、`switch_model: the session controller is not available in this deployment` 与 `list_models: the session controller is not available in this deployment`。`model/selection` 会话事件是持久记录，而非第二条模型消息。

#### Token 影响

切换结果小而固定形状；列表结果随可路由模型数与失败 provider 数增长，两者在压缩前保留在调用历史中。

#### KV Cache 影响

仅追加；新可见内容跟随可复用请求前缀，不会使现有 KV-cache 条目失效。

## 已知限制与遗留工作

<a id="known-limitations-and-deferred-work"></a>


- **没有控制器意味着调用时报错，而非隐藏工具**——没有 `sessionController` 服务的部署（headless、SDK）保留两个工具在目录中，只有调用落地时才暴露固定错误，因此该模式下的 agent 只能通过调用得知路由不可用。

-----

<a id="dev-note"></a>
### 开发备注

- 模型可见文本在 `src/index.ts` 中逐字固定，并由单元测试与 loader-composition 测试断言；改动它们时同步更新断言。
- `scripts/gen-tool-catalog.ts` 中的工具目录条目在一个已携带 `tools` 与 `systemPrompt` 的上下文上挂载该包；启动时不需要控制器，与调用时的惰性查找一致。

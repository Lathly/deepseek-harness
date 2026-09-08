---
description: "面向 ctx.web 的自托管 SearXNG 搜索 provider:部署如何将自有元搜索引擎实例挂载为免凭证的搜索后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

使用 `dsh-web-search-searxng` 后,harness 通过部署自己的 SearXNG 元搜索引擎实例检索网页,无需 API key,也没有第三方看到查询。SearXNG 把查询分发到实例配置的各引擎并返回合并后的 `results[]`;provider 将其映射为可移植的来源,并把实例可选的 `answers[]` 块折入结果的 `content`——这是家族中唯一能携带生成式答案的搜索后端。没有 URL 的结果会被丢弃,引擎分发产生的重复 URL 只保留首条。模型面向的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载 provider;它注册为 `searxng` 搜索 provider,当它是唯一可用的搜索后端时 `ctx.web.search()` 会自动解析它——或者当还有其他可用 provider 时用 `searchProvider: searxng` 固定它(`deepseek-official` provider 在没有 API key 时也报告可用,因此两者共存的部署必须固定,否则每次搜索都会以 `WEB_PROVIDER_AMBIGUOUS` 失败)。

### 何时选择

当部署运行自己的 SearXNG 实例、想要免凭证且完全在本地完成的网页搜索时,选择此后端:查询与引擎组合都留在部署自己的硬件上。当实例 base 无法解析或某个 filter 被设置但为空时,provider 不可用——每次搜索调用都会以结构化错误失败。实例本身必须提供 JSON API(在 SearXNG 的 `settings.yml` 中于 `search.formats` 启用 `json`);未启用的实例返回非 JSON 响应体,表现为 `WEB_PROVIDER_ERROR`。

### 最小配置

加载 web 服务与 provider;实例 base 回落到启动环境的 `$SEARXNG_URL`,再回落到本地默认 `http://localhost:8888`,其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://localhost:8888
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_URL`,再为 `http://localhost:8888` | SearXNG 实例 base;追加 `/search`。无法解析的值使 provider 不可用 |
| `engines` | (未设置) | 以 SearXNG 的 `engines` 发送的逗号分隔引擎白名单;在实例已配置的引擎内收窄 |
| `categories` | (未设置) | 以 SearXNG 的 `categories` 发送的逗号分隔分类 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)是全部可接受字段及其 JSDoc 的完整来源。

### 搜索返回什么

每条 SearXNG 结果映射为一个 `WebSearchSource`:`url`、非空时的 `title`、修剪后的 `content` 作为 `snippet`、引擎提供时的 `publishedDate` 作为 `publishedAt`。没有 URL 的条目被丢弃,重复 URL 保留首条。非空 `answers[]` 折入结果的 `content`;当实例没有答案类引擎时没有 `content`。SearXNG 没有结果数参数,因此请求的 `maxResults` 在服务端约束最终来源,而不是约束请求——实例自身的分发仍完整执行。

### 失败与恢复

provider 失败——HTTP 错误、网络故障、不可解析或形状错误的响应体——表现为 `WebError` `WEB_PROVIDER_ERROR`;被中止的请求表现为 `WEB_ABORTED`。HTTP 重定向在接触 `Location` 目标之前被拒绝,表现为 `WEB_PROVIDER_ERROR`。调用方按错误码路由;模型面向的 `web_search` 工具在其自身错误包装下向模型呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释 provider 背后的设计决策;可观察行为已完整覆盖于[使用本包](#use-this-package)。

### 设计哲学

该 provider 是 SearXNG JSON API 之上的薄适配层,遵循三条刻意规则:

- **构造上即免凭证。** SearXNG 的 API 不需要 key,因此没有可泄露之物;provider 仍然选择加入家族的拒绝重定向策略,使行为异常或被中间人篡改的实例也无法把查询转发到其他源。
- **只出可移植来源。** 来源的 `snippet` 只取自 SearXNG 的 `content` 字段;空值或带填充的值被修剪或省略,绝不虚构。
- **诚实的答案。** `answers[]` 是实例自身的自由文本答案块;它被折入 `content` 而非丢弃,因为这是线上已存在生成式答案的唯一位置。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口:配置 schema、环境变量回退、provider 注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`:请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | SearXNG 线上类型:`SearxngResponse`、`SearxngResult` |
| — | 不发布运行时 invariant 伴生包;此包没有超出其所属 seam 强制契约的独立事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 向 `{baseURL}/search?q=<query>&format=json` 发起 GET,附可选的 `engines` 与 `categories` 参数并设 `redirect: 'error'`,使重定向在不接触目标的情况下失败。解析出的 `results[]` 逐条映射,无 URL 条目丢弃,重复项去除,最终 `maxResults` 边界在回程时由服务施加。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`;其余一律变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

当包级契约不够时阅读这些页面。它们从共享词汇到服务、模型面向工具与设计理由逐层深入。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 完整的搜索请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md) — 家族全貌与各包角色。
- [dsh-web](../web/README.zh.md) — 本 provider 注册其中的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本 provider 来源的模型面向 `web_search` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng) — 每个可接受配置字段及其来源声明。
- [Web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 为什么搜索与抓取共享同一 provider 选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接经由 `dsh-tool-web`:它保留本 provider 的 `maxResults` 有界 URL、标题、摘要、发布时间与实例答案块,或其在消费方错误包装下的精确失败文本 `SearXNG search aborted`、`SearXNG search request failed: <error>`、`SearXNG returned an unprocessable response body: <error>`。

#### KV 缓存影响

无直接失效;具名消费方负责任何请求前缀变化。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了何时该 provider 不是合适选择。它们是当前包的约束。

- **实例必须启用 JSON API** — SearXNG 的 `settings.yml` 中 `search.formats` 必须启用 `json`;纯 HTML 实例会使每次搜索以 `WEB_PROVIDER_ERROR` 失败,而非 harness 可报告的配置错误。
- **实例侧控制面未暴露** — 引擎组合、分类默认值与答案块取决于实例的 `settings.yml` 与引擎集;`engines` 与 `categories` 只能在其中收窄。
- **`maxResults` 在分发之后约束** — SearXNG 没有结果数参数,实例先取回全集再由服务截断;较大的实例答案付出完整时延。
- **中止分类基于错误形状** — 只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`;携带自定义原因(如 `dsh-timeout` 的 `TimeoutReason`)的中止表现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文:开放问题与未定方向。它明确不具权威性——已交付行为、限制与理由位于上文各节及所链 Agent Note。

#### 未来:更宽的 SearXNG 控制面

SearXNG 的 `time_range`、`safesearch` 与 `language` 控制暂未暴露。暴露它们需要先有 provider 中性的服务字段,因此家族添加一个协调控制,而非供应商专属参数。

</details>

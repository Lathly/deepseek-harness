# Agent Note:SearXNG web 搜索 provider

Status: implemented

[English](2026-09-04-web-search-searxng-provider.md) | 中文

## 问题

web 能力 seam 中每个随发的搜索 provider 都需要供应商 key:`dsh-web-search-exa` 要 Exa key,`dsh-web-search-perplexity` 要 Perplexity key,`dsh-web-search-deepseek` 依赖部署的 DeepSeek key。想要无任何 key 的网页搜索的部署——自建 SearXNG 元搜索引擎实例,查询与引擎组合都留在自己硬件上——没有可挂载的 provider,`web_search` 以缺 key 错误失败。

## 决策

`packages/web/web-search-searxng`(`@deepseek-ai/dsh-web-search-searxng`)在 `ctx.web` 上注册 `searxng` 搜索 provider,以普通 `GET /search?q=<query>&format=json` 加可选 `engines` / `categories` 参数访问实例的 JSON API。它不带凭证,选择加入家族的拒绝重定向策略(`redirect: 'error'`),并把 SearXNG 响应体映射到 seam 的可移植词汇:`results[]` 映射为来源(无 URL 条目丢弃,重复 URL 去重,`content` 修剪为 `snippet`,可空的 `publishedDate` 映射为 `publishedAt`),实例的 `answers[]` 自由文本块折入结果的 `content`。

插件配置为 `baseURL`(回退链 `$SEARXNG_URL`,再为本地默认 `http://localhost:8888`——社区 SearXNG Docker skill 发布的端口)加两个 filter。provider 的 `available()` 只要求 base URL 可解析且 filter 非空,因此没有实例运行的部署也能加载该 row;每次搜索以结构化 `WEB_PROVIDER_ERROR` 失败,而不是加载失败。

该 row 为选用:不在随发的 base 组合中;部署在 `deepseek-official` provider 始终可用的同时启用它,必须固定 `web` 的 `searchProvider: searxng`,否则每次搜索都会以 `WEB_PROVIDER_AMBIGUOUS` 失败——seam 的选择规则保持原形,本 note 只记录本地部署现在会撞上这条规则。

## 备选方案

**把现有 provider 指向 SearXNG。** 否决:每个已发货 provider 的线上协议、鉴权与映射都是供应商专属;SearXNG 是无鉴权 GET 加自有响应体,硬塞进 Exa 或 DeepSeek 的适配器会让两者都违背自身契约。

**绕过 seam:让模型经 shell curl SearXNG。** 否决:那会绕过 provider 选择服务、可移植来源词汇、家族错误码与拒绝重定向的回归策略——模型拿到原始 HTTP 而非可引用来源。

**作为默认搜索 provider 发货。** 否决:默认意味着假定本地端点存活,无实例的新安装会在接近启动的时点让每次搜索失败,而非首次搜索时失败;带 key 门槛的默认值把这个失败模式挡在盒外。

## 后果

- 部署获得免凭证、完全本地的网页搜索,走 seam 的可移植来源、错误码与取消契约;SearXNG 的 `answers[]` 是家族中首个作为 `content` 传给模型的生成式答案。
- 代价:家族多一个需维护的 provider;实例侧配置(`settings.yml` JSON 格式、引擎集、limiter)在 harness 之外——配置错误的实例表现为 `WEB_PROVIDER_ERROR`,而非 harness 可报告的配置错误。
- 歧义规则现在会咬住本地部署:在始终可用的 `deepseek-official` 旁挂载 `searxng` 而不固定 `searchProvider`,是硬失败而非回退。

## 测试

单元测试:映射、可用性、请求形状、中止与错误处理、证明 `Location` 目标永不被接触的拒绝重定向回归,以及经真实本地 `node:http` 端点的 provider(`tests/searxng.spec.ts`)。真实组合:插件在 `Context` + `WebRuntime` 中启动,端到端服务 `ctx.web.search()`,只 mock HTTP 端点。E2E:活实例冒烟测试在 `$SEARXNG_URL` 或本地默认无实例应答时自跳过(`tests/searxng.e2e.ts`)。

## 相关

- [Web 能力 seam 决策](../architecture/2026-06-24-web-capability-seam.zh.md)

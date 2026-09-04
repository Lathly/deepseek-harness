---
description: "The model-facing switch_model and list_models tools over the session controller's LLM route, for users and maintainers choosing, configuring, or debugging session model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-model-switch

English | [中文](README.zh.md)

## Summary

`dsh-tool-model-switch` gives the agent two tools to route its own model: `switch_model` moves the calling session to another provider/model route, and `list_models` reports the routes the deployment can serve. The switch takes effect from the session's next model request, is recorded in the session log, and also moves the deployment default that new sessions start from. Mount the package in any agent preset; in a deployment without a session controller the tools stay visible and fail at call time with a fixed error.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the agent should choose its own model route at run time — for example to free GPU memory for a local task by switching to a lighter model, then switching back. Mount the package in an agent preset and the agent gains both tools; no configuration exists. The agent is expected to call `list_models` first, then `switch_model` with a route it read there.

### When to choose it

- The deployment serves more than one model route (several providers, or several models on one provider) and the agent should be able to move between them.
- The session should own its route: a switch recorded in its log and replayed on resume.

### When not to choose it

- The deployment has exactly one route; the tools report it but the switch has nowhere else to go.
- The deployment mounts no session controller (headless, SDK): the calls fail with a fixed error, which is the only signal the route is unavailable in that mode.

## Understand the implementation

The package is a function plugin that registers the two tools on `ctx.tools` and injects only the tool registry. Each execution looks up the optional `sessionController` service lazily through `ctx.get`, so mounting the package never blocks on the service: a deployment without it simply fails the individual calls at call time. `switch_model` normalizes the arguments into one `selectModel` request — the empty-string `reasoning_effort` is omitted so the provider default applies — and renders the controller's normalized selection back to the model. `list_models` renders the controller's catalog: the default selection, each routable provider group with its models, and the isolated provider failures.

Both tools are session contributions, which is why the package mounts from agent presets rather than the host composition. The `sessionController` service itself stays in the host plane, provided by the Web surface.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`switch_model` and `list_models` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-model-switch): `switch_model` takes required `provider` and `model` route ids plus an optional `reasoning_effort`, and `list_models` takes no arguments.

#### Token effect

Fixed schema cost on every request where the tools are visible; the descriptions and schemas are deployment-stable.

#### KV Cache effect

Prefix-stable while the tool definitions are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and result

#### What the model sees

Each `switch_model` call retains its route arguments. Success returns exactly `Switched this session's model to <provider>/<model>` plus ` (reasoning effort <effort>)` when the controller echoes an effort back, closed by `Effective from the next model request; the default for new sessions now matches this selection.` `list_models` returns the default route, one line per provider group, one line per model, and one line per failed provider, joined by newlines. Stable failures are `switch_model: no agent context for this call`, `switch_model: the session controller is not available in this deployment`, and `list_models: the session controller is not available in this deployment`. The `model/selection` session event is the durable record, not a second model message.

#### Token effect

The switch result is small and fixed-shape; the list result scales with the number of routable models and failed providers, and both remain in the call history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **No controller means a call-time error, not a hidden tool** — deployments without the `sessionController` service (headless, SDK) keep both tools in the catalog and only surface the fixed error when a call lands, so an agent there learns the route is unavailable by calling.

-----

<a id="dev-note"></a>
### Dev Note

- The model-visible texts are pinned verbatim in `src/index.ts` and asserted by the unit and loader-composition specs; change them with those assertions.
- The tool-catalog entry in `scripts/gen-tool-catalog.ts` mounts the package on a context that already carries `tools` and `systemPrompt`; the controller is not required at boot, matching the lazy call-time lookup.

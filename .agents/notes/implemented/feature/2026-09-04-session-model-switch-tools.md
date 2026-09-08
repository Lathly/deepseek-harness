# Agent Note: session model-switch tools (list_models / switch_model)

Status: implemented

English | [中文](2026-09-04-session-model-switch-tools.zh.md)

## Problem

A session had no model-visible way to change which LLM route it runs on. The use case is a local router with a cached-model limit: to free GPU memory for a local task the agent should switch itself to a lighter or differently placed model, run the task, and switch back — and it should be able to discover the available routes and the current default first. Before this, changing the route meant editing settings or restarting, and a session-local dynamic Cordis plugin proved the model-facing text and the controller contract but disappears on every process restart and cannot be shipped in a preset.

## Decision

`packages/llm/tool-model-switch` registers two tools on `ctx.tools`:

- **`switch_model(provider, model, reasoningEffort?)`** delegates to the `sessionController` service's `selectModel`: the switch appends a durable `model/selection` session event and updates the deployment default for new sessions, taking effect from the agent's next model request. The `reasoningEffort` parameter is adapter-owned and optional; an empty string is treated as omitted.
- **`list_models`** renders the `sessionController` `modelCatalog`: the default selection, provider groups with their models, and any providers whose catalog failed to load. A group line prints `id (name):` only when the display name differs from the id.

The controller is looked up lazily at call time with `ctx.get('sessionController')`, so the package loads anywhere `tools` is present. In a deployment that mounts no session controller (headless or SDK profiles) both tools stay visible in the catalog and fail at call time with a fixed error (`switch_model: the session controller is not available in this deployment`, and the `list_models` equivalent), so a call is the only way to discover the route is unavailable. The model-facing description, parameter, and result texts are pinned verbatim from the validated session-local plugin.

The tools are a model-facing consumer of the existing selection seam: [the default model follows the picker](../../archived/feature/2026-08-07-default-model-follows-the-picker.md) owns the `agent-default-model` persistence and the `model/selection` event, and the [Web session model selector](../../archived/feature/2026-07-24-web-session-model-selector.md) is the user-facing editor of the same preference; this note adds no new state, only the tool surface over `sessionController`.

The agent presets (`standard`, `ptc`, `cordis`) mount the package after the `tool-web` block; `minimal` stays clean. The `sessionController` service remains a host-plane contribution (the Web surface provides it), and `packages/bundle/base` carries the new dependency so preset specifier resolution finds the package. The package has no `Config`; there is nothing deployment-varying to configure.

## Alternatives considered

**Keep the dynamic Cordis plugin as the mechanism.** Rejected: session-local, gone on restart, needs per-session approval, and cannot appear in a shipped preset, so the behavior could never be a default.

**Client-only UI action, no model tool.** Rejected: the switching decision belongs to the model (it is the one that knows it is about to run a local task); a UI-only seam leaves the model blind to the routes it could switch to.

**Hard `inject` on `sessionController`.** Rejected: the package would wait or fail at load in every deployment without the service, hiding the tools instead of failing loudly at call time. The lazy `ctx.get` keeps loading unconditional and pushes the fixed error to the first call.

**Host-composition mount instead of presets.** Rejected: the tools are per-session contributions whose `switch_model` call requires a calling Agent session; the agent presets own the per-session tool registries.

## Testing

Unit (`packages/llm/tool-model-switch/tests/tool-model-switch.spec.ts`): the registration surface (both tool names, the projected object schemas with the top-level `required` array, the `presentCall` views), HMR safety through fiber disposal, `switch_model` paths (plain, with effort, empty-string effort omitted, missing agent context, missing controller, controller rejection propagation), and `list_models` rendering (default line, group-line asymmetry, model description lines, catalog failure lines, missing controller). Real composition (`tests/loader-composition.spec.ts`) boots a temporary `cordis.yml` through the real Cordis Loader with `dsh-agent`, `dsh-system-prompt`, `dsh-tools`, and the package, serves a mocked `sessionController` through `ctx.provide`, executes both tools through the real registry, and asserts the normalized request, the rendered results, and the call-time failures in a composition without the controller. Per-file coverage on the package source is 100%. The snapshot corpus carries zero references to the new tools, so the recorded-session lane is unaffected.

## Consequences

- The model can re-route its own session mid-conversation; the switch is durable (session event) and moves the deployment default through the [existing persistence seam](../../archived/feature/2026-08-07-default-model-follows-the-picker.md), applying from the next model request. On a router with a cached-model limit the switch call itself is fast and the model load is lazy, on the next request.
- The standard, ptc, and cordis preset catalogs gain two schemas (a three-property object and an empty object), a small standing token cost in those presets.
- Headless and SDK deployments see the tools and get the fixed call-time error instead of a hidden capability.
- The session-local dynamic plugin that validated the text is now redundant and can be retired once the permanent path is verified on a live instance.

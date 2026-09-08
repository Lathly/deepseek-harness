---
description: "The self-hosted SearXNG search provider for ctx.web: how deployments mount their own metasearch instance as a credential-free search backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches the web through a deployment's own SearXNG metasearch instance, with no API key and no third party seeing the query. SearXNG fans the query out to the instance's configured engines and returns one merged `results[]`; the provider maps it to portable sources and folds the instance's optional `answers[]` block into the result's `content` — the only search backend in the family that can carry a generated answer. A result without a URL is dropped, and duplicate URLs from the engine fan-out keep their first entry. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `searxng` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: searxng` when another usable provider is present (the `deepseek-official` provider reports usable without an API key, so a deployment with both must pin or every search fails with `WEB_PROVIDER_AMBIGUOUS`).

### When to choose it

Choose this backend when a deployment runs its own SearXNG instance and wants credential-free, on-premise web search: the queries and the engine mix stay on the deployment's hardware. The provider is unavailable — and every search call fails with a structured error — when the instance base does not parse or a filter is set but blank. The instance itself must serve the JSON API (`json` enabled under `search.formats` in SearXNG's `settings.yml`); an instance without it answers with a non-JSON body, which surfaces as `WEB_PROVIDER_ERROR`.

### Minimal configuration

Load the web service and the provider; the instance base falls back to `$SEARXNG_URL` from the launch environment, then to the local default `http://localhost:8888`, and every other setting has a safe default.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://localhost:8888
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_URL`, then `http://localhost:8888` | SearXNG instance base; `/search` is appended. An unparseable value makes the provider unavailable |
| `engines` | (unset) | Comma-separated engine allow-list sent as SearXNG's `engines`; it narrows within the instance's configured engines |
| `categories` | (unset) | Comma-separated category sent as SearXNG's `categories` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each SearXNG result maps to a `WebSearchSource`: `url`, `title` when non-blank, the trimmed `content` as `snippet`, and `publishedDate` as `publishedAt` when the engine supplied one. Entries without a URL are dropped and duplicate URLs keep their first entry. Non-blank `answers[]` join into the result's `content`; when the instance has no answer-capable engine there is no `content`. SearXNG has no result-count parameter, so a request's `maxResults` bounds the final sources in the service rather than the request — the instance's own fan-out still runs in full.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over SearXNG's JSON API with three deliberate rules:

- **Credential-free by construction.** SearXNG's API takes no key, so there is nothing to leak; the provider opts into the family's redirect-rejection policy anyway, so a misbehaving or MITM'd instance cannot forward the query to another origin.
- **Portable sources only.** A source gains a `snippet` only from SearXNG's `content` field; blank or padded values are trimmed or omitted, never invented.
- **Honest answers.** `answers[]` is the instance's own free-text answer block; it is joined into `content` rather than dropped, because that is the one place a generated answer already exists on the wire.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types: `SearxngResponse`, `SearxngResult` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` gets `{baseURL}/search?q=<query>&format=json` with optional `engines` and `categories` parameters and `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, URL-less entries dropped, duplicates removed, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets, publication dates, and instance answer blocks or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **The instance must enable its JSON API** — `json` must be enabled under `search.formats` in SearXNG's `settings.yml`; an HTML-only instance makes every search fail with `WEB_PROVIDER_ERROR` rather than a configuration error the harness can report.
- **Instance-side controls are not exposed** — the engine mix, category defaults, and answer blocks are whatever the instance's `settings.yml` and engine set provide; `engines` and `categories` only narrow within them.
- **`maxResults` bounds after the fan-out** — SearXNG has no result-count parameter, so the instance retrieves its full set before the service truncates; a large instance answer costs its full latency.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider SearXNG control surface

SearXNG's `time_range`, `safesearch`, and `language` controls stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>

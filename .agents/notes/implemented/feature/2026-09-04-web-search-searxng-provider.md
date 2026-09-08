# Agent Note: SearXNG web search provider

Status: implemented

English | [中文](2026-09-04-web-search-searxng-provider.zh.md)

## Problem

Every shipped search provider in the web capability seam is vendor-keyed: `dsh-web-search-exa` needs an Exa key, `dsh-web-search-perplexity` a Perplexity key, and `dsh-web-search-deepseek` rides the deployment's DeepSeek key. A deployment that wants web search without any key — its own SearXNG metasearch instance, queries and engine mix staying on its own hardware — had no provider to mount, and `web_search` failed with a missing-key error.

## Decision

`packages/web/web-search-searxng` (`@deepseek-ai/dsh-web-search-searxng`) registers a `searxng` search provider on `ctx.web` that reaches the instance's JSON API with a plain `GET /search?q=<query>&format=json` and optional `engines` / `categories` parameters. It takes no credential, opts into the family's redirect-rejection policy (`redirect: 'error'`), and maps SearXNG's envelope to the portable seam vocabulary: `results[]` to sources (URL-less entries dropped, duplicate URLs deduplicated, `content` trimmed into `snippet`, nullable `publishedDate` into `publishedAt`), and the instance's `answers[]` free-text block joined into the result's `content`.

The plugin config is `baseURL` (fallback chain `$SEARXNG_URL`, then the local default `http://localhost:8888` — the port the community SearXNG Docker skill publishes) plus the two filters. The provider's `available()` requires only a parseable base URL and non-blank filters, so a deployment with no instance running still loads the row; every search fails with a structured `WEB_PROVIDER_ERROR` instead of a load failure.

The row is opt-in: it is not in the shipped base composition, and a deployment enabling it while the always-available `deepseek-official` provider is present must pin `web`'s `searchProvider: searxng`, or every search fails with `WEB_PROVIDER_AMBIGUOUS` — the seam's selection rule keeps its shape, the note just records that local deployments now hit it.

## Alternatives considered

**Repoint an existing provider at SearXNG.** Rejected: each shipped provider's wire protocol, auth, and mapping are vendor-specific; SearXNG is an unauthenticated GET with its own envelope, and bolting it onto Exa's or DeepSeek's adapter would make both lie about their contracts.

**Skip the seam: let models curl SearXNG through the shell.** Rejected: that bypasses the provider-selection service, the portable source vocabulary, the family's error codes, and the redirect-rejection regression policy — the model gets raw HTTP instead of citeable sources.

**Ship it as a default search provider.** Rejected: a default presumes a live local endpoint, and a fresh install with no instance would fail every search at boot-adjacent time rather than at the first search; the key-gated shipped defaults keep that failure mode out of the box.

## Consequences

- Deployments gain credential-free, on-premise web search through the seam's portable sources, error codes, and cancellation contract; SearXNG's `answers[]` is the first generated answer the family carries to the model as `content`.
- Cost: one more provider in the family to maintain, and instance-side configuration (`settings.yml` JSON format, engine set, limiter) sits outside the harness — a misconfigured instance surfaces as `WEB_PROVIDER_ERROR` rather than a configuration error the harness can report.
- The ambiguity rule now bites for local deployments: mounting `searxng` beside the always-available `deepseek-official` without pinning `searchProvider` is a hard failure, not a fallback.

## Testing

Unit: mapping, availability, request shape, abort and error handling, a redirect-rejection regression proving the `Location` target is never contacted, and a provider over a real local `node:http` endpoint (`tests/searxng.spec.ts`). Real-composition: the plugin boots into `Context` + `WebRuntime` and serves `ctx.web.search()` end to end with only the HTTP endpoint mocked. E2E: a live-instance smoke test self-skips when no instance answers at `$SEARXNG_URL` or the local default (`tests/searxng.e2e.ts`).

## Related

- [Web capability seam decision](../architecture/2026-06-24-web-capability-seam.md)

/**
 * Self-hosted SearXNG `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service; the instance is reached
 * through its plain JSON API, so no API key is involved and a deployment
 * keeps its own search stack — and its queries — on its own hardware.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SearxngSearchProvider, SEARXNG_DEFAULT_BASE_URL } from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
  mapSearxngResult,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'
export type { SearxngResponse, SearxngResult } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Environment variable naming this provider's SearXNG instance. */
const SEARXNG_URL_ENV = 'SEARXNG_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** SearXNG instance base; `/search` is appended. Falls back to `$SEARXNG_URL`, then the local default. */
  baseURL?: string
  /** Comma-separated engine allow-list sent as `engines` (e.g. `google,duckduckgo`). */
  engines?: string
  /** Comma-separated category sent as `categories` (e.g. `general,news`). */
  categories?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  engines: z.string(),
  categories: z.string(),
})

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    // Every environment layer may name the instance: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(SEARXNG_URL_ENV)?.value ?? SEARXNG_DEFAULT_BASE_URL,
    ...config.engines !== undefined && config.engines.length > 0 ? { engines: config.engines } : {},
    ...config.categories !== undefined && config.categories.length > 0 ? { categories: config.categories } : {},
  }))
}

/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a self-hosted
 * SearXNG instance's JSON API (`GET /search?format=json`). It maps `results[]`
 * to portable sources, drops entries without a URL, deduplicates by URL, and
 * folds non-blank `answers[]` into the result's `content`. SearXNG has no
 * result-count parameter, so `maxResults` is enforced by the seam.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngResult, SearxngResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Default SearXNG instance base: the local OpenClaw skill container
 * (`searxng-openclaw`) published on port 8888. A deployment naming another
 * instance sets `baseURL` in the plugin config or `$SEARXNG_URL`.
 */
export const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8888'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` fills env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** SearXNG instance base; `/search` is appended. */
  baseURL: string
  /** Comma-separated engine allow-list sent as `engines`; omitted = instance defaults. */
  engines?: string
  /** Comma-separated category sent as `categories`; omitted = instance defaults. */
  categories?: string
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it carries
 * no URL. Blank optional fields are omitted rather than emitted, and a
 * whitespace-only snippet counts as absent (SearXNG pads `content` with an
 * ellipsis but leaves it `""` for bare redirects).
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` for an entry without a URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (typeof result.url !== 'string' || result.url.length === 0) return undefined
  const title = typeof result.title === 'string' && result.title.length > 0 ? result.title : undefined
  const snippet = typeof result.content === 'string' && result.content.trim().length > 0
    ? result.content.trim()
    : undefined
  const publishedAt = typeof result.publishedDate === 'string' && result.publishedDate.length > 0
    ? result.publishedDate
    : undefined
  return {
    url: result.url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result. Duplicate
 * URLs (one per engine fan-out) keep their first entry; non-blank `answers[]`
 * join into `content`. The web service owns the final `maxResults` truncation,
 * so this provider reports `truncated: false`.
 *
 * @param response - the parsed `GET /search?format=json` body.
 * @returns the normalized result.
 */
export function mapSearxngResponse(response: SearxngResponse): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const result of response.results ?? []) {
    const source = mapSearxngResult(result)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  const answers = (response.answers ?? [])
    .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
    .map(answer => answer.trim())
  return {
    ...answers.length > 0 ? { content: answers.join('\n\n') } : {},
    sources,
    truncated: false,
  }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  /** True when the endpoint parses and every named filter is non-blank. */
  available(): boolean {
    return URL.canParse(this.options.baseURL)
      && (this.options.engines === undefined || this.options.engines.length > 0)
      && (this.options.categories === undefined || this.options.categories.length > 0)
  }

  /** Run one search against the instance's JSON API. */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const params = new URLSearchParams({ q: request.query, format: 'json' })
    if (this.options.engines !== undefined) params.set('engines', this.options.engines)
    if (this.options.categories !== undefined) params.set('categories', this.options.categories)
    const url = `${this.options.baseURL.replace(/\/+$/, '')}/search?${params.toString()}`

    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG error (HTTP ${status})`
      try {
        const body = await response.text()
        const detail = body.trim().slice(0, 200)
        if (detail.length > 0) message = `${message}: ${detail}`
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the status is already captured in `message`; a failed body
        // read (normal for connection resets) can only cost a richer detail.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('body is not a SearXNG response object')
      }
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    // The JSON parse cannot prove field types: a wire body carrying a
    // non-array `results` or `answers` must surface as a provider error,
    // not a TypeError in the mapping below.
    const body = payload as SearxngResponse
    const results = (body as { results?: unknown }).results
    if (results !== undefined && !Array.isArray(results)) {
      throw new WebError('SearXNG returned an unprocessable response body: `results` is not an array', 'WEB_PROVIDER_ERROR')
    }
    const answers = (body as { answers?: unknown }).answers
    if (answers !== undefined && !Array.isArray(answers)) {
      throw new WebError('SearXNG returned an unprocessable response body: `answers` is not an array', 'WEB_PROVIDER_ERROR')
    }
    return mapSearxngResponse(body)
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

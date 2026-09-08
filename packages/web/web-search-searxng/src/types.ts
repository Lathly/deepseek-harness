/**
 * Wire vocabulary for the SearXNG JSON API (`GET /search?format=json`). SearXNG
 * emits `null` for absent optional fields, so every optional here admits null.
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's `results[]`; only the portable fields are named. */
export interface SearxngResult {
  readonly url?: string | null
  readonly title?: string | null
  readonly content?: string | null
  readonly engine?: string | null
  readonly engines?: string[] | null
  readonly category?: string | null
  /** Publication/crawl timestamp; SearXNG emits `null` when the engine has none. */
  readonly publishedDate?: string | null
  readonly score?: number | null
}

/** The parsed body of one SearXNG JSON search response. */
export interface SearxngResponse {
  readonly query?: string
  readonly results?: SearxngResult[]
  /** Free-text answer blocks; empty when the instance has no answer-capable engine. */
  readonly answers?: string[]
  readonly suggestions?: string[]
}

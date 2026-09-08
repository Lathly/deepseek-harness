import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider, SEARXNG_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-searxng'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'

/**
 * Live-instance smoke for the SearXNG search provider. Self-skips when no
 * instance answers at `$SEARXNG_URL` (or the local default) — CI runs no
 * SearXNG container, per the with-key e2e policy in docs/testing.md.
 */
const baseURL = process.env.SEARXNG_URL ?? SEARXNG_DEFAULT_BASE_URL

/** True for the network-layer failures of a downed or unreachable instance. */
function isUnreachable(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code !== undefined && code.startsWith('E')) return true
    if (cause.message.includes('fetch failed') || cause.message.includes('ECONNREFUSED')) return true
  }
  return false
}

describe('SearxngSearchProvider live instance', () => {
  it('returns normalized sources for a live query', async (context) => {
    const provider = new SearxngSearchProvider({ baseURL })
    let result: WebSearchResult
    try {
      result = await provider.search({ query: 'AI agents', maxResults: 5 })
    } catch (error) {
      if (isUnreachable(error)) context.skip()
      throw error
    }
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    expect(result.truncated).toBe(false)
  }, 30_000)
})

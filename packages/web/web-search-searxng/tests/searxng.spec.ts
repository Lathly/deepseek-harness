/**
 * SearXNG provider mapping, availability, request shape, and error handling,
 * plus a real-composition boot (Context + WebRuntime + plugin) observing the
 * search through the seam with only the HTTP endpoint mocked.
 */

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import {
  SearxngSearchProvider,
  SEARXNG_PROVIDER_ID,
  mapSearxngResult,
  mapSearxngResponse,
} from '@deepseek-ai/dsh-web-search-searxng'
import type { SearxngResponse } from '@deepseek-ai/dsh-web-search-searxng'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/** One instance-shaped response: one result per engine fan-out, an answer, a duplicate URL. */
const INSTANCE_BODY: SearxngResponse = {
  query: 'AI agents',
  results: [
    { url: 'https://a.test', title: 'A', content: 'snippet a', engines: ['google'], publishedDate: '2026-01-01' },
    { url: 'https://a.test', title: 'A (dup)', content: 'duplicate from a second engine' },
    { url: 'https://b.test', content: null, title: null, publishedDate: null },
    { title: 'no url', content: 'orphan' },
  ],
  answers: ['AI agents are programs that act on behalf of a user.', '  '],
  suggestions: ['AI agents in production'],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SearXNG result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: 'A', content: 'snippet', publishedDate: '2026-01-01' }))
      .toEqual({ url: 'https://a.test', title: 'A', snippet: 'snippet', publishedAt: '2026-01-01' })
  })

  it('drops an entry without a URL and omits null/blank optionals', () => {
    expect(mapSearxngResult({ title: 'no url', content: 'orphan' })).toBeUndefined()
    expect(mapSearxngResult({ url: 'https://b.test', content: null, title: null, publishedDate: null }))
      .toEqual({ url: 'https://b.test' })
    expect(mapSearxngResult({ url: 'https://c.test', content: '   ' })).toEqual({ url: 'https://c.test' })
  })

  it('trims a padded snippet', () => {
    expect(mapSearxngResult({ url: 'https://d.test', content: '  padded…  ' }))
      .toEqual({ url: 'https://d.test', snippet: 'padded…' })
  })

  it('maps a response: dedupes by URL, folds answers into content', () => {
    const result = mapSearxngResponse(INSTANCE_BODY)
    expect(result.sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'snippet a', publishedAt: '2026-01-01' },
      { url: 'https://b.test' },
    ])
    expect(result.content).toBe('AI agents are programs that act on behalf of a user.')
    expect(result.truncated).toBe(false)
  })

  it('omits content when every answer is blank and tolerates missing arrays', () => {
    const result = mapSearxngResponse({ results: [{ url: 'https://a.test' }], answers: ['  '] })
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: false })
    expect(result.content).toBeUndefined()
    expect(mapSearxngResponse({})).toEqual({ sources: [], truncated: false })
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is available for a parseable base URL with no filters', () => {
    expect(new SearxngSearchProvider({ baseURL: 'http://localhost:8888' }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new SearxngSearchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when a filter is set but blank', () => {
    expect(new SearxngSearchProvider({ baseURL: 'http://localhost:8888', engines: '' }).available()).toBe(false)
    expect(new SearxngSearchProvider({ baseURL: 'http://localhost:8888', categories: '' }).available()).toBe(false)
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends a GET with query, JSON format, filters and attribution; rejects redirects', async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SearxngSearchProvider({
      baseURL: 'http://searx.test/',
      engines: 'google,duckduckgo',
      categories: 'general',
    })
    await provider.search({ query: 'AI agents' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://searx.test/search?q=AI+agents&format=json&engines=google%2Cduckduckgo&categories=general')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ accept: 'application/json', 'user-agent': 'deepseek-harness/0.0.1' })
  })

  it('omits filter params that were never set', async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://searx.test/search?q=q&format=json')
  })

  it('lets a request maxResults cap the sources without asking the instance for fewer', async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q', maxResults: 3 })
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('maxresults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }, controller.signal)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal)
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the status-line message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG error (HTTP 502): gateway down' }))
  })

  it('keeps a bare status-line message when the error body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'SearXNG error (HTTP 503)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: {} })))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse('just text')))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ answers: 'nope' })))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => body as unknown as Response))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('SearxngSearchProvider over a real local HTTP endpoint', () => {
  it('fetches the instance, maps the wire body, and never follows a redirect', async () => {
    const seenPaths: string[] = []
    const server = http.createServer((request, response) => {
      seenPaths.push(request.url ?? '')
      // The provider always requests `<path>?query`, so match on the path prefix.
      const path = request.url ?? ''
      if (path.startsWith('/search')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(INSTANCE_BODY))
        return
      }
      if (path.startsWith('/redirect')) {
        response.writeHead(302, { location: '/target' })
        response.end()
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const provider = new SearxngSearchProvider({ baseURL })
      const result = await provider.search({ query: 'AI agents' })
      expect(result.sources.map(source => source.url)).toEqual(['https://a.test', 'https://b.test'])
      expect(result.truncated).toBe(false)

      // The redirect regression: an endpoint answering 3xx is a provider error
      // and its Location target is never contacted.
      const redirecting = new SearxngSearchProvider({ baseURL: `${baseURL}/redirect` })
      await expect(redirecting.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      expect(seenPaths.some(path => path.startsWith('/target'))).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      })
    }
  })
})

describe('web-search-searxng plugin (real composition)', () => {
  it('registers the provider into ctx.web and serves a search through the seam', async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse(INSTANCE_BODY))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const pluginFiber = ctx.plugin(searxngPlugin, { baseURL: 'http://searx.test' })
    await pluginFiber.await()

    // One registered provider is auto-selected by the seam: the request
    // reaches the configured instance and the response normalizes end to end.
    const result = await ctx.web.search({ query: 'AI agents', maxResults: 2 })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.test', 'https://b.test'])
    expect(fetchMock).toHaveBeenCalledOnce()

    await ctx.fiber.dispose()
  })

  it('reports the provider id and a missing URL config falls back to the local default', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const pluginFiber = ctx.plugin(searxngPlugin, {})
    await pluginFiber.await()

    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('http://localhost:8888/search')
    expect(pluginFiber).toBeDefined()
    expect(searxngPlugin.name).toBe('web-search-searxng')
    expect(SEARXNG_PROVIDER_ID).toBe('searxng')

    await ctx.fiber.dispose()
  })

  it('resolves the instance from $SEARXNG_URL when the config leaves baseURL unset', async () => {
    process.env.SEARXNG_URL = 'http://searxng.example'
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      const pluginFiber = ctx.plugin(searxngPlugin, {})
      await pluginFiber.await()

      const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('http://searxng.example/search')

      await ctx.fiber.dispose()
    } finally {
      delete process.env.SEARXNG_URL
    }
  })

  it('sends configured engine and category filters through the seam', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const pluginFiber = ctx.plugin(searxngPlugin, { baseURL: 'http://searx.test', engines: 'google', categories: 'news' })
    await pluginFiber.await()

    const fetchMock = vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('engines=google&categories=news')

    await ctx.fiber.dispose()
  })
})

describe('SearxngSearchProvider error-body handling', () => {
  it('keeps a bare status-line message when the error body cannot be read', async () => {
    const body = { text: () => Promise.reject(new Error('socket reset')), ok: false, status: 502 }
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => body as unknown as Response))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG error (HTTP 502)' }))
  })

  it('surfaces an abort during error-body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async (_input?: string | URL | RequestInfo, _init?: RequestInit) => body as unknown as Response))
    await expect(new SearxngSearchProvider({ baseURL: 'http://searx.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('SearxngSearchProvider availability with filters', () => {
  it('is available for a parseable base URL with non-blank filters', () => {
    expect(new SearxngSearchProvider({ baseURL: 'http://searx.test', engines: 'google', categories: 'news' }).available())
      .toBe(true)
  })
})

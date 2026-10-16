import { afterEach, describe, expect, it, vi } from 'vitest'

import { graphBatch, graphGet, graphList, retryAfter } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Microsoft Graph client', () => {
  it('refreshes a provider token once after a 401', async () => {
    const provider = vi.fn().mockReturnValueOnce('expired').mockReturnValue('fresh')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await graphGet(resolveMsGraphConfig({ accessToken: provider }), 'https://x.test')

    expect(result.id).toBe('ok')
    expect(provider).toHaveBeenCalledTimes(2)
    const refreshedInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined
    expect(refreshedInit?.headers).toMatchObject({
      Authorization: 'Bearer fresh',
    })
  })

  it('follows @odata.nextLink without repeating the first-page query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ value: [{ id: 'a' }], '@odata.nextLink': 'https://x.test/page-2' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ id: 'b' }] }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await graphList(
      resolveMsGraphConfig({ accessToken: 'token' }),
      'https://x.test/items',
      { $select: 'id' },
    )

    expect(result.map((item) => item.id)).toEqual(['a', 'b'])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('%24select=id')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://x.test/page-2')
  })

  it('sends a batch relative to the service root and answers in order', async () => {
    const api = 'https://graph.example/v1.0'
    const urls = [`${api}/me/drive/root:/a:/children`, `${api}/me/drive/root/children`]
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          responses: [
            { id: '1', status: 200, body: { value: [1] } },
            { id: '0', status: 429, headers: { 'retry-after': '7' }, body: 'throttled' },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const answers = await graphBatch(
      resolveMsGraphConfig({ accessToken: 'token', graphBaseUrl: api }),
      [...urls, urls[0] ?? ''],
    )

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${api}/$batch`)
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined
    expect(JSON.parse(init?.body ?? '')).toEqual({
      requests: [
        { id: '0', method: 'GET', url: '/me/drive/root:/a:/children' },
        { id: '1', method: 'GET', url: '/me/drive/root/children' },
        { id: '2', method: 'GET', url: '/me/drive/root:/a:/children' },
      ],
    })
    expect(answers).toEqual([
      [429, {}, 7],
      [200, { value: [1] }, 0],
      [0, {}, 0],
    ])
  })

  it.each([
    [{ 'Retry-After': '3' }, 3],
    [{ 'Retry-After': '900' }, 30],
    [{ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, 0],
    [{}, 0],
  ])('reads a batched Retry-After %o as a capped count of seconds', (headers, wait) => {
    expect(retryAfter(headers)).toBe(wait)
  })
})

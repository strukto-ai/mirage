import { afterEach, describe, expect, it, vi } from 'vitest'

import { graphGet, graphList } from './client.ts'
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
})

import { describe, expect, it, vi } from 'vitest'
import { WandbClient } from './client.ts'
import { normalizeWandbConfig } from './config.ts'
import { WandbAPIError } from './errors.ts'
function connection(cursor: string | null, more: boolean) {
  return {
    models: {
      edges: [{ node: { name: 'one' } }],
      pageInfo: { endCursor: cursor, hasNextPage: more },
    },
  }
}
function client(options: Record<string, unknown> = {}) {
  return new WandbClient(normalizeWandbConfig({ entities: ['lab'], ...options }))
}
describe('W&B client', () => {
  it.each([
    ['https://api.test:443', 'https://api.test/file', true],
    ['https://API.TEST', 'https://api.test/file', true],
    ['https://api.test', 'https://API.TEST:443/file', true],
    ['http://API.TEST:80', 'http://api.test/file', true],
    ['https://API.TEST:8443', 'https://api.test:8443/file', true],
    ['https://api.test', '/files/a', true],
    ['https://api.test', 'https://storage.test/file', false],
    ['https://api.test', 'http://api.test/file', false],
    ['https://api.test', 'https://api.test:8443/file', false],
    ['https://api.test:8443', 'https://api.test/file', false],
  ] as const)(
    'compares normalized download origins: %s -> %s',
    async (base_url, target, authenticated) => {
      const c = client({ base_url, api_key: 'fixture-key' })
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('file bytes'))
      vi.stubGlobal('fetch', request)
      try {
        const chunks = []
        for await (const chunk of c.download(target)) chunks.push(new TextDecoder().decode(chunk))
        expect(chunks.join('')).toBe('file bytes')
        expect(request).toHaveBeenCalledExactlyOnceWith(new URL(target, base_url + '/'), {
          headers: authenticated ? c.headers() : {},
        })
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )
  it.each([undefined, 'fixture-key'])('sends JSON with api_key=%s', async (api_key) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const sent = new Request(input, init)
      expect(sent.url).toBe('https://api.wandb.ai/graphql')
      expect(sent.method).toBe('POST')
      expect(sent.headers.get('Content-Type')).toBe('application/json')
      expect(sent.headers.get('Authorization')).toBe(
        api_key ? `Basic ${btoa(`api:${api_key}`)}` : null,
      )
      expect(await sent.json()).toEqual({ query: '{ viewer { id } }', variables: {} })
      return Response.json({ data: { viewer: { id: 'caller' } } })
    })
    vi.stubGlobal('fetch', request)
    try {
      expect(await client({ api_key }).request('{ viewer { id } }', {})).toEqual({
        viewer: { id: 'caller' },
      })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('paginates independently per call', async () => {
    const c = client({ page_size: 1 })
    const request = vi
      .spyOn(c, 'request')
      .mockResolvedValueOnce(connection('next', true))
      .mockResolvedValueOnce(connection(null, false))
      .mockResolvedValueOnce(connection(null, false))
    expect(await c.projects('lab')).toHaveLength(2)
    expect(await c.projects('other')).toHaveLength(1)
    expect(request.mock.calls.map((call) => call[1].cursor)).toEqual([null, 'next', null])
  })
  // Twin of test_a_walks_limit_pages_no_further.
  it('pages no further than a walk limit', async () => {
    const c = client({ page_size: 1, max_pages: 1 })
    const request = vi.spyOn(c, 'request').mockResolvedValue(connection('next', true))
    expect(await c.projects('lab', 1)).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('refuses a repeated cursor', async () => {
    const c = client()
    const request = vi.spyOn(c, 'request').mockResolvedValue(connection('same', true))
    await expect(c.projects('lab')).rejects.toThrow('did not advance')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('fails loudly when the page budget is exhausted', async () => {
    const c = client({ max_pages: 1 })
    vi.spyOn(c, 'request').mockResolvedValue(connection('next', true))
    await expect(c.projects('lab')).rejects.toThrow('limit exceeded')
  })
  it('scans past an empty step window and preserves missing metrics', async () => {
    const c = client({ page_size: 2 })
    const rows = [
      { _step: 0, train_step: 100, score: 0.8 },
      { _step: 5, loss: null },
    ]
    const request = vi
      .spyOn(c, 'request')
      .mockResolvedValueOnce({ project: { run: { historyKeys: { lastStep: 5 } } } })
      .mockResolvedValueOnce({ project: { run: { history: [JSON.stringify(rows[0])] } } })
      .mockResolvedValueOnce({ project: { run: { history: [] } } })
      .mockResolvedValueOnce({ project: { run: { history: [JSON.stringify(rows[1])] } } })
    const received = []
    for await (const row of c.history({ entity: 'lab', project: 'p', run: 'id' }))
      received.push(row)
    expect(received).toEqual(rows)
    expect(request.mock.calls.slice(1).map((call) => call[1].minStep)).toEqual([0, 2, 4])
  })
  it('fails on GraphQL errors without exposing response secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: { models: null }, errors: [{ message: 'secret-value' }] }),
          ),
        ),
    )
    try {
      await expect(client().projects('lab')).rejects.toEqual(
        new WandbAPIError('W&B GraphQL request failed'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

it.each([
  [1, 0],
  [1, 3],
  [3, 3],
])('preserves a snapshot with page size %i and last step %i', async (size, last) => {
  const c = client({ page_size: size })
  const rows = Array.from({ length: last + 2 }, (_, _step) => ({ _step }))
  vi.spyOn(c, 'request').mockImplementation((query, variables) => {
    if (query.includes('query HistoryKeys'))
      return Promise.resolve({ project: { run: { historyKeys: { lastStep: last } } } })
    const start = variables.minStep as number,
      stop = variables.maxStep as number
    expect(stop - start).toBeGreaterThanOrEqual(2)
    return Promise.resolve({
      project: {
        run: {
          history: rows
            .filter((row) => start <= row._step && row._step < stop)
            .map((row) => JSON.stringify(row)),
        },
      },
    })
  })
  const result = []
  for await (const row of c.history({ entity: 'lab', project: 'p', run: 'id' })) result.push(row)
  expect(result).toEqual(rows.slice(0, -1))
})

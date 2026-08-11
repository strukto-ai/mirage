import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mem0Accessor } from '../../accessor/mem0.ts'
import { PathSpec } from '../../types.ts'
import { read, readdir, searchRendered, stat } from './index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Mem0 filesystem', () => {
  it('requires exactly one configured scope', () => {
    expect(() => new Mem0Accessor({ apiKey: 'key' })).toThrow(/exactly one/)
    expect(() => new Mem0Accessor({ apiKey: 'key', userId: 'u', agentId: 'a' })).toThrow(
      /exactly one/,
    )
  })

  it('paginates the configured scope and renders memories as JSON files', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 'm1', memory: 'first', updated_at: '2026-01-01' }],
            next: 'page-2',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 'm2', memory: 'second' }], next: null }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'm1', memory: 'first' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'm1', memory: 'first' }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex', defaultPageSize: 1 })
    const root = PathSpec.fromStrPath('/memories', '')
    const memory = PathSpec.fromStrPath('/memories/m1.json', 'm1.json')

    expect(await readdir(accessor, root)).toEqual(['/memories/m1.json', '/memories/m2.json'])
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(firstInit?.body).toBe(JSON.stringify({ filters: { user_id: 'alex' } }))
    expect(firstInit?.headers).toMatchObject({
      Authorization: 'Token key',
      'Mem0-User-ID': '3c6e0b8a9c15224a8228b9a98ca1531d',
    })
    expect(new TextDecoder().decode(await read(accessor, memory))).toContain('"memory": "first"')
    expect((await stat(accessor, memory)).type).toBe('json')
  })

  it('translates a missing memory into ENOENT', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: 'Memory not found' }), { status: 404 }),
        ),
    )
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex' })
    const missing = PathSpec.fromStrPath('/memories/gone.json', 'gone.json')

    await expect(read(accessor, missing)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(accessor, missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates a non-404 provider failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex' })
    const path = PathSpec.fromStrPath('/memories/m1.json', 'm1.json')

    await expect(read(accessor, path)).rejects.toThrow(/status 500/)
  })

  it('renders filtered semantic results with scores', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { id: 'keep', memory: 'remember me', score: 0.875 },
              { id: 'skip', memory: 'skip me', score: 0.5 },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new Mem0Accessor({ apiKey: 'key', agentId: 'agent' })

    const output = await searchRendered(
      accessor,
      'remember',
      '/memories',
      5,
      0.2,
      new Set(['keep']),
    )

    expect(new TextDecoder().decode(output)).toBe('/memories/keep.json:0.88\nremember me\n')
  })
})

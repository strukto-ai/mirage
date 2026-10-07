import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mem0Accessor } from '../../accessor/mem0.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'
import { searchResults } from './search.ts'
import { stat } from './stat.ts'

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
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex', defaultPageSize: 1 })
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/memories', '')
    const memory = PathSpec.fromStrPath('/memories/m1.json', 'm1.json')

    expect(await readdir(accessor, root, index)).toEqual(['/memories/m1.json', '/memories/m2.json'])
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(firstInit?.body).toBe(JSON.stringify({ filters: { user_id: 'alex' } }))
    expect(firstInit?.headers).toMatchObject({
      Authorization: 'Token key',
      'Mem0-User-ID': '3c6e0b8a9c15224a8228b9a98ca1531d',
    })
    // The listing carries every payload, so read and stat answer from it.
    expect(new TextDecoder().decode(await read(accessor, memory, index))).toContain(
      '"memory": "first"',
    )
    expect((await stat(accessor, memory, index)).content).toBe('json')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // Which memories exist is the configured entity's listing; the read used to
  // fetch any id in the file name, so `cat` served another user's memory that
  // `ls` never showed.
  it('refuses a memory the scoped listing does not hold', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [{ id: 'm1', memory: 'mine' }], next: null }), {
          status: 200,
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex' })
    const other = PathSpec.fromStrPath('/memories/theirs.json', 'theirs.json')

    await expect(read(accessor, other)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(accessor, other)).rejects.toMatchObject({ code: 'ENOENT' })
    // Only the scoped listing was asked, never a fetch by the file's id.
    for (const [url] of fetchMock.mock.calls as [URL][]) {
      expect(url.pathname).toBe('/v3/memories/')
    }
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

    const output = await searchResults(accessor, 'remember', '/memories', 5, 0.2, new Set(['keep']))

    expect(output.map(([, text]) => text).join('\n') + (output.length ? '\n' : '')).toBe(
      '/memories/keep.json:0.88\nremember me\n',
    )
  })
})

describe('mem0 detectScope', () => {
  it('classifies the mount root', () => {
    const match = detectScope(new PathSpec({ virtual: '/mem', directory: '/mem', vfsPath: '' }))
    expect(match.kind).toBe('root')
    expect(match.slots).toEqual({})
  })

  it('classifies a memory file and carries the id', () => {
    const p = new PathSpec({
      virtual: '/mem/abc.json',
      directory: '/mem',
      vfsPath: 'abc.json',
    })
    const match = detectScope(p)
    expect(match.kind).toBe('memory')
    expect(match.slots).toEqual({ memory_id: 'abc' })
  })

  it('classifies a hidden name as invalid', () => {
    const p = new PathSpec({
      virtual: '/mem/.secret',
      directory: '/mem',
      vfsPath: '.secret',
    })
    expect(detectScope(p).kind).toBe('invalid')
  })

  it('classifies an empty memory id as invalid', () => {
    const p = new PathSpec({ virtual: '/mem/.json', directory: '/mem', vfsPath: '.json' })
    expect(detectScope(p).kind).toBe('invalid')
  })

  it('classifies a nested path as invalid', () => {
    const p = new PathSpec({
      virtual: '/mem/a.json/b',
      directory: '/mem',
      vfsPath: 'a.json/b',
    })
    expect(detectScope(p).kind).toBe('invalid')
  })
})

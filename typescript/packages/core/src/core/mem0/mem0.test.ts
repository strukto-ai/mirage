import { afterEach, describe, expect, it, vi } from 'vitest'

import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Mem0Accessor } from '../../accessor/mem0.ts'
import { SEARCH } from '../../commands/cli/builtin/search/index.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import { Limit, MountMode, PathSpec, type FileStat } from '../../types.ts'
import { Mem0VFS } from '../../vfs/mem0/mem0.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'
import { searchMany, searchMemoriesRendered } from './search.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mounted(config: ConstructorParameters<typeof Mem0VFS>[0]): Workspace {
  return new Workspace({ '/memories/': new Mem0VFS(config) })
}

describe('Mem0 filesystem', () => {
  it('requires exactly one configured scope', () => {
    expect(() => new Mem0Accessor({ apiKey: 'key' })).toThrow(/exactly one/)
    expect(() => new Mem0Accessor({ apiKey: 'key', userId: 'u', agentId: 'a' })).toThrow(
      /exactly one/,
    )
  })

  it('paginates the configured scope and renders memories as JSON files', async () => {
    const pages = [
      { results: [{ id: 'm1', memory: 'first', updated_at: '2026-01-01' }], next: 'page-2' },
      { results: [{ id: 'm2', memory: 'second' }], next: null },
    ]
    const fetchMock = vi.fn()
    fetchMock.mockImplementation(() => {
      const page = pages[(fetchMock.mock.calls.length - 1) % pages.length]
      return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex', defaultPageSize: 1 })
    const root = PathSpec.fromStrPath('/memories', '')
    const rows = await readdir(accessor, root)
    expect(Array.isArray(rows) ? rows.map((row) => row.name) : []).toEqual(['m1.json', 'm2.json'])
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(firstInit?.body).toBe(JSON.stringify({ filters: { user_id: 'alex' } }))
    expect(firstInit?.headers).toMatchObject({
      Authorization: 'Token key',
      'Mem0-User-ID': '3c6e0b8a9c15224a8228b9a98ca1531d',
    })
    // The listing carries every payload, so read and stat answer from it.
    const ws = mounted({ apiKey: 'key', userId: 'alex', defaultPageSize: 1 })
    await ws.dispatch('readdir', '/memories')
    const data = (await ws.dispatch('read', '/memories/m1.json')) as Uint8Array
    expect(new TextDecoder().decode(data)).toContain('"memory": "first"')
    expect(((await ws.dispatch('stat', '/memories/m1.json')) as FileStat).content).toBe('json')
    expect(fetchMock).toHaveBeenCalledTimes(4)
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
    const ws = mounted({ apiKey: 'key', userId: 'alex' })

    await expect(ws.dispatch('read', '/memories/theirs.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(ws.dispatch('stat', '/memories/theirs.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // Only the scoped listing was asked, never a fetch by the file's id.
    for (const [url] of fetchMock.mock.calls as [URL][]) {
      expect(url.pathname).toBe('/v3/memories/')
    }
  })

  it('propagates a non-404 provider failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    const ws = mounted({ apiKey: 'key', userId: 'alex' })

    await expect(ws.dispatch('read', '/memories/m1.json')).rejects.toThrow(/status 500/)
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

    const output = await searchMemoriesRendered(
      accessor,
      'remember',
      '/memories',
      5,
      0.2,
      new Set(['keep']),
    )

    expect(output).toEqual([['/memories/keep.json', '/memories/keep.json:0.88\nremember me']])
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

// Twin of test_search_refuses_an_option_before_asking_mem0.
it.each([
  ['search --threshold 2 plans /m', 1, 'threshold must be in [0, 1]'],
  ['search --top-k 0 plans /m', 2, 'top-k must be positive'],
  ['search --method keyword plans /m', 1, "only the 'semantic' method is supported"],
])('%s is refused before mem0 is asked', async (line, exitCode, stderr) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const ws = new Workspace(
    { '/m': new Mem0VFS({ apiKey: 'key', userId: 'alex' }) },
    { shellParser: await getTestParser() },
  )
  ws.registerCli('search', SEARCH)
  try {
    const result = await ws.shell(line)
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderrText).toBe(`search: ${stderr}\n`)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

// Twin of test_search_many_refuses_before_listing_a_glob: a glob scope is
// expanded by listing the memories, so a value the search refuses is refused
// before that listing.
it.each([
  [{ query: 'morning', options: { threshold: 1.5 } }, 'threshold'],
  [{ query: 'morning', options: { top_k: 0 } }, 'top-k'],
  [{ query: '' }, 'query'],
])('searchMany refuses %o before listing a glob', async (query, message) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const accessor = new Mem0Accessor({ apiKey: 'key', agentId: 'routine_agent' })
  const glob = new PathSpec({
    virtual: '/mem/*.json',
    directory: '/mem',
    vfsPath: '*.json',
    pattern: '*.json',
    resolved: false,
  })
  await expect(searchMany(accessor, [glob], query)).rejects.toThrow(message)
  expect(fetchMock).not.toHaveBeenCalled()
})

// Twin of the parse refusals in test_search_refusals: search's usage errors
// exit 2 like the ones it raises itself.
it('refuses a value its spec types as a usage error', async () => {
  const ws = new Workspace(
    { '/m': new Mem0VFS({ apiKey: 'key', userId: 'alex' }) },
    { shellParser: await getTestParser() },
  )
  ws.registerCli('search', SEARCH)
  try {
    const result = await ws.shell('search --top-k many plans /m')
    expect(result.exitCode).toBe(2)
    expect(result.stderrText).toBe(
      "search: invalid int value: 'many' for '--top-k'\nTry 'search --help' for more information.\n",
    )
  } finally {
    await ws.close()
  }
})

// Twin of test_find_pages_the_memories_no_further_than_its_walk_limit.
it('lets find page memories no further than its walk limit', async () => {
  const fetchMock = vi.fn()
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          results: [{ id: `m${String(fetchMock.mock.calls.length)}`, memory: 'x' }],
          next: 'more',
        }),
        { status: 200 },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const vfs = new Mem0VFS({ apiKey: 'key', userId: 'alex', defaultPageSize: 1 })
  const ws = new Workspace(
    { '/m': [vfs, MountMode.READ, { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }] },
    { shellParser: await getTestParser() },
  )
  try {
    await ws.shell('find /m')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  } finally {
    await ws.close()
  }
})

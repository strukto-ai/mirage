import { expect, it, vi } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import { PathSpec } from '../types.ts'
import { intOption, searchResources } from './search.ts'
import { runWithSession } from '../context/session_context.ts'
import { SessionState } from '../workspace/session/session.ts'
import type { SearchResult } from './types.ts'

const path = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })

it.each([false, true])('checks inputs and filters whole records (batch=%s)', async (batch) => {
  const hidden = PathSpec.fromStrPath('/data/private/secret')
  const shown = PathSpec.fromStrPath('/data/private/public')
  const callback = vi.fn((): Promise<SearchResult[]> =>
    Promise.resolve([
      [hidden, '/data/public:pretend-visible\nsecret body'],
      [shown, 'allowed\nsecond line'],
    ]),
  )
  const capability = { search: callback, ...(batch ? { searchMany: callback } : {}) }
  const session = new SessionState({
    sessionId: 'reader',
    visibility: {
      paths: { paths: ['/data/private'] },
      shown: { entries: [{ path: '/data/private/public', mode: null }] },
    },
  })
  await runWithSession(session, async () => {
    const output = await searchResources(capability, new Accessor(), [path], { query: 'q' })
    expect(new TextDecoder().decode(output)).toBe('allowed\nsecond line\n')
    callback.mockClear()
    await expect(
      searchResources(capability, new Accessor(), [path, hidden], { query: 'q' }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(callback).not.toHaveBeenCalled()
  })
})

it('refuses unaddressed search results', async () => {
  const search = () => Promise.resolve(['unattributed content'] as unknown as SearchResult[])
  await expect(searchResources({ search }, new Accessor(), [path], { query: 'q' })).rejects.toThrow(
    'PathSpec',
  )
})

it('ranks a batch once and preserves options', async () => {
  const search = vi.fn(() => Promise.reject(new Error('must use batch ranking')))
  const searchMany = vi.fn(() =>
    Promise.resolve([[path, 'highest'] as const, [path, 'second'] as const]),
  )
  const accessor = new Accessor()
  const query = { query: 'question', options: { top_k: 2 } }
  const out = await searchResources({ search, searchMany }, accessor, [path, path], query)
  expect(new TextDecoder().decode(out)).toBe('highest\nsecond\n')
  expect(searchMany).toHaveBeenCalledOnce()
  expect(searchMany).toHaveBeenCalledWith(accessor, [path, path], query, undefined)
  expect(search).not.toHaveBeenCalled()
})

it('reports a declined batch instead of treating it as no matches', async () => {
  await expect(
    searchResources(
      { search: () => Promise.resolve([]), searchMany: () => Promise.resolve(null) },
      new Accessor(),
      [path],
      { query: 'query' },
    ),
  ).rejects.toThrow('declined')
})

it.each([true, '10', null, 1.5])('rejects non-integer limit %j', (value) => {
  expect(() => intOption({ query: 'query', options: { top_k: value } }, 'top_k', 10)).toThrow(
    'integer',
  )
})

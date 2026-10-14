import { expect, it, vi } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import { PathSpec } from '../types.ts'
import { intOption, searchResources } from './search.ts'

const path = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })

it('ranks a batch once and preserves options', async () => {
  const search = vi.fn(() => Promise.reject(new Error('must use batch ranking')))
  const searchMany = vi.fn(() =>
    Promise.resolve<[string, string][]>([
      ['/data/a', 'highest'],
      ['/data/b', 'second'],
    ]),
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

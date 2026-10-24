import { expect, it, vi } from 'vitest'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { onMount, vfsOver } from '../../test-utils.ts'
import { ChromaVFS } from '../../vfs/chroma/chroma.ts'
import { PathSpec } from '../../types.ts'
import { searchResources } from '../../commands/builtin/generic/search.ts'
import { filesContaining, searchMany, searchSegments } from './search.ts'

it('ranks a batch through the dispatcher once and preserves the mount prefix', async () => {
  const query = vi.fn(() =>
    Promise.resolve({
      documents: [['hello']],
      metadatas: [[{ slug: 'doc.txt' }]],
      distances: [[0.2]],
    }),
  )
  const accessor = {
    config: { slugField: 'slug' },
    getCollection: () => Promise.resolve({ query }),
  } as unknown as ChromaAccessor
  const root = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })
  const result = await onMount(
    vfsOver(ChromaVFS, accessor),
    (files) =>
      searchResources(files.dispatch, [root, root], {
        query: 'question',
        options: { top_k: 2 },
      }),
    '/data',
  )
  expect(new TextDecoder().decode(result)).toContain('/data/doc.txt:')
  expect(query).toHaveBeenCalledOnce()
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ queryTexts: ['question'], nResults: 2 }),
  )
})

// Twin of test_files_containing_names_the_pages_a_chunk_holds_text_in: a
// page is its chunks joined by line breaks, so a chunk holding the text is
// the page holding it; Chroma matches case, so -i asks nothing.
it('names the pages a chunk holds the text in', async () => {
  const chunks = [
    { document: 'second', metadata: { page_slug: 'guides/quickstart' } },
    { document: 'first', metadata: { page_slug: 'guides/quickstart' } },
    { document: 'api chunk', metadata: { page_slug: 'api/reference' } },
  ]
  const get = vi.fn(
    (args: { whereDocument?: { $contains?: string }; limit: number; offset: number }) => {
      const held = args.whereDocument?.$contains ?? ''
      const found = chunks
        .filter((c) => c.document.includes(held))
        .slice(args.offset, args.offset + args.limit)
      return Promise.resolve({
        ids: found.map((_, i) => String(i)),
        metadatas: found.map((c) => c.metadata),
      })
    },
  )
  const accessor = {
    config: { slugField: 'page_slug' },
    getCollection: () => Promise.resolve({ get }),
  } as unknown as ChromaAccessor
  const root = new PathSpec({ virtual: '/knowledge', directory: '/knowledge', vfsPath: '' })
  const out = await filesContaining(accessor, 'first', [root], false)
  expect(out?.map((p) => p.virtual)).toEqual(['/knowledge/guides/quickstart'])
  expect(get).toHaveBeenLastCalledWith(
    expect.objectContaining({ whereDocument: { $contains: 'first' } }),
  )
  expect(await filesContaining(accessor, 'nowhere', [root], false)).toEqual([])
  expect(await filesContaining(accessor, 'first', [root], true)).toBeNull()
})

// Twin of test_files_containing_asks_only_the_walked_pages_below_the_root.
it('asks only the walked pages below the mount root', async () => {
  const tree = JSON.stringify({ 'guides/quickstart': {}, 'api/reference': {} })
  const get = vi.fn(
    (args: {
      ids?: string[]
      where?: { page_slug: { $in: string[] } }
      whereDocument?: { $contains?: string }
    }) => {
      if (args.ids !== undefined) return Promise.resolve({ ids: args.ids, documents: [tree] })
      const kept = args.where?.page_slug.$in ?? []
      const found = kept.includes('guides/quickstart') ? [{ page_slug: 'guides/quickstart' }] : []
      return Promise.resolve({ ids: found.map((_, i) => String(i)), metadatas: found })
    },
  )
  const accessor = {
    config: { slugField: 'page_slug' },
    getCollection: () => Promise.resolve({ get }),
  } as unknown as ChromaAccessor
  const api = new PathSpec({
    virtual: '/knowledge/api',
    directory: '/knowledge/api',
    vfsPath: 'api',
  })
  expect(await filesContaining(accessor, 'first', [api], false)).toEqual([])
  expect(get).toHaveBeenLastCalledWith(
    expect.objectContaining({ where: { page_slug: { $in: ['api/reference'] } } }),
  )
})

// Twin of test_search_segments_drops_a_hit_scored_below_the_threshold.
it('drops a hit scored below the threshold', async () => {
  const query = vi.fn(() =>
    Promise.resolve({
      documents: [['quickstart chunk', 'api chunk']],
      metadatas: [[{ page_slug: 'guides/quickstart' }, { page_slug: 'api/reference' }]],
      distances: [[0.1, 0.25]],
    }),
  )
  const accessor = {
    config: { slugField: 'page_slug' },
    getCollection: () => Promise.resolve({ query }),
  } as unknown as ChromaAccessor
  const result = await searchSegments(accessor, 'setup', [], 10, '/knowledge/', 0.8)
  expect(result.map(([path]) => path)).toEqual(['/knowledge/guides/quickstart'])
})

// Twin of test_search_many_refuses_any_method_but_semantic.
it('refuses any method but semantic', async () => {
  const accessor = { config: { slugField: 'page_slug' } } as unknown as ChromaAccessor
  await expect(
    searchMany(accessor, [], { query: 'setup', options: { method: 'hybrid' } }),
  ).rejects.toThrow("search: only the 'semantic' method is supported")
})

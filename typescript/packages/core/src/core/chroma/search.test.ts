import { expect, it, vi } from 'vitest'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { ioFor } from '../../test-utils.ts'
import { ChromaVFS } from '../../vfs/chroma/chroma.ts'
import { PathSpec } from '../../types.ts'
import { searchResources } from '../../vfs/search.ts'
import { filesContaining } from './search.ts'

it('ranks a batch through SearchOps once and preserves the mount prefix', async () => {
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
  const result = await searchResources(ioFor(ChromaVFS, accessor).search, accessor, [root, root], {
    query: 'question',
    options: { top_k: 2 },
  })
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

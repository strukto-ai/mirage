import { expect, it, vi } from 'vitest'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { ioFor } from '../../test-utils.ts'
import { ChromaVFS } from '../../vfs/chroma/chroma.ts'
import { PathSpec } from '../../types.ts'
import { searchResources } from '../../vfs/search.ts'

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
  expect(ioFor(ChromaVFS, accessor).search?.meta?.grep).toBeUndefined()
})

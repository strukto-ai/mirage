// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../../core/dify/client.ts'

vi.mock('../../../core/dify/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../../core/dify/client.ts')
  return {
    ...actual,
    listAllDocuments: vi.fn(() =>
      Promise.resolve([
        doc('doc-1', 'Guide', 'guides/quickstart.md'),
        doc('doc-2', 'Guide 2', 'guides/deep/note.md'),
      ]),
    ),
    getDocumentDetail: vi.fn(() => Promise.reject(new Error('unexpected document-detail call'))),
  }
})

import type { ChromaAccessor } from '../../../accessor/chroma.ts'
import type { DifyAccessor } from '../../../accessor/dify.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { runWithSession } from '../../../context/session_context.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import { DIFY_COMMANDS } from '../dify/index.ts'
import { CHROMA_COMMANDS } from '../chroma/index.ts'
import { parseFindExpression } from '../find_parse.ts'
import { readsSizes, readsTimes } from './find.ts'
import type { NamespaceView } from '../../../doors/types.ts'
import type { Visibility } from '../../../types.ts'
import { hiddenUnder } from '../../../utils/hidden.ts'
import { ioFor } from '../../../test-utils.ts'
import { ChromaVFS } from '../../../vfs/chroma/chroma.ts'
import { DifyVFS } from '../../../vfs/dify/dify.ts'

// The command's view as the workspace builds it for a session.
function viewOf(vis: Visibility): NamespaceView {
  return { visibility: vis, scoped: (virtual: string) => hiddenUnder(vis, virtual) }
}

function doc(id: string, name: string, slug: string): Record<string, unknown> {
  return {
    id,
    name,
    doc_metadata: [{ name: 'slug', value: slug }],
    enabled: true,
    indexing_status: 'completed',
    archived: false,
    tokens: 4,
    data_source_type: 'upload_file',
    data_source_detail_dict: { upload_file: { size: 12 } },
    created_at: 1716282000,
  }
}

describe('readsTimes and readsSizes', () => {
  it.each([
    [['-name', '*.md'], false, false],
    [['-name', '-size'], false, false],
    [['-mtime', '-1'], true, false],
    [['-mtime', '+0', '-o', '-mtime', '-1'], true, false],
    [['-newer', '/knowledge/README.md'], true, false],
    [['-newermt', '2024-01-01'], true, false],
    [['-size', '+1k'], false, true],
    [['!', '-empty'], false, true],
    [['-printf', '%TY %s\n'], false, false],
  ])('which fields %j tests', (texts, times, sizes) => {
    const expr = parseFindExpression(texts)
    expect([readsTimes(expr), readsSizes(expr)]).toEqual([times, sizes])
  })
})

describe('slug-tree find under a hide', () => {
  it('a hidden child leaves its directory empty', async () => {
    const find = DIFY_COMMANDS.find((c) => c.name === 'find')
    if (find === undefined) throw new Error('dify registers no find')
    const accessor = { config: { slugMetadataName: 'slug' } } as DifyAccessor
    const guides = new PathSpec({
      virtual: '/knowledge/guides',
      directory: '/knowledge/guides',
      vfsPath: mountKey('/knowledge/guides', '/knowledge'),
    })
    const sess = new SessionState({ sessionId: 'veiled' })
    sess.visibility = { ...sess.visibility, paths: { paths: ['/knowledge/guides/deep/note.md'] } }
    const opts = {
      stdin: null,
      flags: {},
      io: ioFor(DifyVFS, accessor),
      cwd: '/',
      index: new RAMIndexCacheStore(),
      ns: viewOf(sess.visibility),
    }
    const result = await runWithSession(sess, async () =>
      find.fn(accessor, [guides], ['-empty'], opts),
    )
    const [stdout, io] = result ?? [null, null]
    expect(new TextDecoder().decode(await materialize(stdout))).toBe('/knowledge/guides/deep\n')
    expect(io?.exitCode).toBe(0)
  })
})

function chromaAccessor(gets: Record<string, unknown>[]): ChromaAccessor {
  const tree = {
    'guides/quickstart': {
      size: 12,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    },
    'api/reference': { size: null, created_at: null, updated_at: null },
  }
  const collection = {
    get: (args: Record<string, unknown>) => {
      gets.push(args)
      if (args.ids !== undefined) return Promise.resolve({ documents: [JSON.stringify(tree)] })
      const slugs = (args.where as { page_slug: { $in: string[] } }).page_slug.$in
      const chunks = slugs.map((slug) => ({
        document: slug,
        metadata: { page_slug: slug, chunk_index: 0 },
      }))
      return Promise.resolve({
        documents: chunks.map((c) => c.document),
        metadatas: chunks.map((c) => c.metadata),
      })
    },
  }
  return {
    config: { slugField: 'page_slug', chunkIndexField: 'chunk_index' },
    getCollection: () => Promise.resolve(collection),
  } as unknown as ChromaAccessor
}

const SIZED = ['-type', 'f', '-size', '+0']
const NEWER = ['-type', 'f', '-newermt', '2026-01-15']
const QUICKSTART = '/knowledge/guides/quickstart'
const REFERENCE = '/knowledge/api/reference'

describe('chroma find', () => {
  it.each([
    [QUICKSTART, SIZED, {}, [REFERENCE], true],
    [null, SIZED, {}, [REFERENCE, QUICKSTART], true],
    [QUICKSTART, [], { type: 'f', size: '+0' }, [REFERENCE], true],
    [REFERENCE, NEWER, {}, [QUICKSTART], false],
    [null, NEWER, {}, [QUICKSTART], false],
    [null, ['quick*'], {}, [QUICKSTART], false],
    [REFERENCE, ['quick*'], {}, [QUICKSTART], false],
  ])(
    'hiding %s, %j %j prints its rows and scans chunks only for a size test',
    async (hidden, texts, flags, rows, scans) => {
      const find = CHROMA_COMMANDS.find((c) => c.name === 'find')
      if (find === undefined) throw new Error('chroma registers no find')
      const gets: Record<string, unknown>[] = []
      const root = new PathSpec({
        virtual: '/knowledge',
        directory: '/knowledge',
        vfsPath: mountKey('/knowledge', '/knowledge'),
      })
      const sess = new SessionState({ sessionId: 'veiled' })
      sess.visibility = { ...sess.visibility, paths: { paths: hidden === null ? [] : [hidden] } }
      const accessor = chromaAccessor(gets)
      const opts = {
        stdin: null,
        flags,
        io: ioFor(ChromaVFS, accessor),
        cwd: '/',
        index: new RAMIndexCacheStore(),
        ns: viewOf(sess.visibility),
      }
      const [stdout, io] = await runWithSession(sess, async () => {
        const result = await find.fn(accessor, [root], texts, opts)
        const [bytes, ioResult] = result ?? [null, null]
        return [new TextDecoder().decode(await materialize(bytes)), ioResult] as const
      })
      expect(stdout.split('\n').filter(Boolean)).toEqual(rows)
      expect(io?.exitCode).toBe(0)
      expect(gets.some((args) => args.where !== undefined)).toBe(scans)
    },
  )
})

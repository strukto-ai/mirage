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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from './drive.ts'

const drive = vi.hoisted(() => ({
  ids: [] as string[],
  complete: true,
  fail: null as Error | null,
  asked: [] as unknown[][],
}))

vi.mock('./drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('./drive.ts')
  return {
    ...actual,
    searchFiles: (_tm: unknown, text: string, parents: string[], mime: string | null) => {
      drive.asked.push([text, parents, mime])
      if (drive.fail !== null) return Promise.reject(drive.fail)
      return Promise.resolve({ ids: drive.ids, complete: drive.complete })
    },
  }
})

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { driveQueries, filesContaining } from './search.ts'

const MIME = 'application/vnd.google-apps.document'
const CORPORA: Record<string, [string, string][]> = {
  owned: [
    ['a', 'doc-a'],
    ['b', 'doc-b'],
  ],
  shared: [['c', 'doc-c']],
}

function rows(key: string): FileStat[] {
  return (CORPORA[key] ?? []).map(
    ([name, id]) =>
      new FileStat({
        name: `${name}.gdoc.json`,
        type: FileType.FILE,
        extra: { doc_id: id, doc_name: name },
      }),
  )
}

function readdir(_accessor: GoogleApiAccessor, path: PathSpec): Promise<DirListing> {
  return Promise.resolve(new DirListing({ entries: rows(path.vfsPath.replace(/^\/+|\/+$/g, '')) }))
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/docs' : `/docs/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

function ask(text: string, under: PathSpec[]): Promise<PathSpec[] | null> {
  const accessor = { tokenManager: null } as unknown as GoogleApiAccessor
  return filesContaining(accessor, readdir, MIME, DOCS_WORDS, text, under)
}

beforeEach(() => {
  drive.ids = []
  drive.complete = true
  drive.fail = null
  drive.asked = []
})

// Twin of python/tests/core/google/test_search.py.
describe('google app filesContaining', () => {
  it.each<[string, string[] | null]>([
    ['wombat', ['wombat']],
    ['Wombat', ['Wombat']],
    ['notes', ['notes', 'otes']],
    ['q4', null],
    ['2024', null],
    ['paragraph', null],
    ['TextRun', null],
    ['NORMAL_TEXT', null],
    ['false', null],
    ['arial', null],
    ['https', null],
    ['face', null],
  ])('driveQueries(%j) is %j', (text, queries) => {
    expect(driveQueries(text, DOCS_WORDS)).toEqual(queries)
  })

  it('answers the walked files Drive names', async () => {
    drive.ids = ['doc-a', 'doc-c', 'elsewhere']
    const out = await ask('wombat', [scope()])
    expect(out?.map((p) => p.virtual)).toEqual([
      '/docs/owned/a.gdoc.json',
      '/docs/shared/c.gdoc.json',
    ])
    expect(drive.asked).toEqual([['wombat', [], MIME]])
  })

  it('walks only a corpus scope', async () => {
    drive.ids = ['doc-a', 'doc-c']
    const out = await ask('wombat', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/a.gdoc.json'])
  })

  it.each<[string, string, string[], boolean, Error | null]>([
    ['paragraph', '', ['doc-a'], true, null],
    ['wombat', 'owned/a.gdoc.json', ['doc-a'], true, null],
    ['wombat', '', ['doc-a'], false, null],
    ['wombat', '', [], true, null],
    ['wombat', '', ['doc-a'], true, new TypeError('down')],
  ])('reads every file for %j under %j when unsure', async (text, under, ids, complete, fail) => {
    drive.ids = ids
    drive.complete = complete
    drive.fail = fail
    expect(await ask(text, [scope(under)])).toBeNull()
  })

  it('asks each query and joins the answers', async () => {
    drive.ids = ['doc-b']
    const out = await ask('notes', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/b.gdoc.json'])
    expect(drive.asked.map(([query]) => query)).toEqual(['notes', 'otes'])
  })

  // Drive could not finish the listing, so it is not the directory, and
  // grep's own walk lists it again and may find more.
  it('reads every file after an unfinished listing', async () => {
    drive.ids = ['a.gdoc.json']
    const unfinished = (_accessor: GoogleApiAccessor, path: PathSpec): Promise<DirListing> =>
      Promise.resolve(
        new DirListing({ entries: rows(path.vfsPath.replace(/^\/+|\/+$/g, '')), partial: true }),
      )
    const accessor = { tokenManager: null } as unknown as GoogleApiAccessor
    expect(
      await filesContaining(accessor, unfinished, MIME, DOCS_WORDS, 'wombat', [scope('owned')]),
    ).toBeNull()
  })
})

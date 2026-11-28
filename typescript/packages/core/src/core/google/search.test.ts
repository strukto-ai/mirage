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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { FILES, GoogleAccount, UNTIL_CLEARED } from '../../../tests/core/google/account.ts'
import { driveQueries, filesContaining } from './search.ts'

const MIME = 'application/vnd.google-apps.document'
const WOMBATS: Record<string, string> = {
  a: 'a wombat',
  b: 'b',
  c: 'c wombat',
  elsewhere: 'elsewhere wombat',
}

type Corpora = Record<string, [string, string][]>

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

/**
 * Make a doc per row name, each named with the words its text holds (a Drive
 * search reads a file's name too), and answer the corpora the app lists them
 * in: a and b owned, c shared. A name the rows do not name is a doc the walk
 * never reaches.
 */
async function corpora(names: Record<string, string>): Promise<Corpora> {
  const ids: Record<string, string> = {}
  for (const [key, name] of Object.entries(names)) ids[key] = await account.create(name, MIME)
  const pick = (keys: string[]): [string, string][] =>
    keys.filter((k) => ids[k] !== undefined).map((k): [string, string] => [k, ids[k] ?? ''])
  return { owned: pick(['a', 'b']), shared: pick(['c']) }
}

function readdirOver(found: Corpora, partial = false) {
  return (_accessor: GoogleApiAccessor, path: PathSpec): Promise<DirListing> =>
    Promise.resolve(
      new DirListing({
        entries: (found[path.vfsPath.replace(/^\/+|\/+$/g, '')] ?? []).map(
          ([name, id]) =>
            new FileStat({
              name: `${name}.gdoc.json`,
              type: FileType.FILE,
              extra: { doc_id: id, doc_name: name },
            }),
        ),
        partial,
      }),
    )
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/docs' : `/docs/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

function ask(
  found: Corpora,
  text: string,
  under: PathSpec[],
  clock?: ManualClock,
): Promise<PathSpec[] | null> {
  const accessor = new GDocsAccessor({ tokenManager: account.tokenManager(clock) })
  return filesContaining(accessor, readdirOver(found), MIME, DOCS_WORDS, text, under)
}

/**
 * Each search asked since recording started: its words, the folders it
 * asked in, and whether it named the app's MIME type.
 */
async function searched(): Promise<[string | null, string[], boolean][]> {
  return (await account.listings())
    .filter((l) => l.text !== null)
    .map((l) => [
      l.text,
      l.folders,
      (new URLSearchParams(l.query).get('q') ?? '').includes(`mimeType='${MIME}'`),
    ])
}

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
    const found = await corpora(WOMBATS)
    await account.run.recordRequests()
    const out = await ask(found, 'wombat', [scope()])
    expect(out?.map((p) => p.virtual)).toEqual([
      '/docs/owned/a.gdoc.json',
      '/docs/shared/c.gdoc.json',
    ])
    expect(await searched()).toEqual([['wombat', [], true]])
  })

  it('walks only a corpus scope', async () => {
    const found = await corpora(WOMBATS)
    const out = await ask(found, 'wombat', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/a.gdoc.json'])
  })

  it.each(['no query', 'a file scope', 'incomplete', 'no hit', 'search fails'])(
    'reads every file when unsure: %s',
    async (unsure) => {
      const found = await corpora({ a: unsure === 'no hit' ? 'a' : 'a wombat paragraph', b: 'b' })
      const text = unsure === 'no query' ? 'paragraph' : 'wombat'
      const under = unsure === 'a file scope' ? 'owned/a.gdoc.json' : ''
      let clock: ManualClock | undefined
      if (unsure === 'incomplete' || unsure === 'search fails') {
        // A search that answers learns the query it is asked with.
        await account.run.recordRequests()
        expect(await ask(found, text, [scope()])).not.toBeNull()
        const [search] = await account.listings()
        if (search === undefined) throw new Error('no search was asked')
        if (unsure === 'incomplete') {
          const asked = await account.run.call<Record<string, JsonValue>>(
            'GET',
            `${FILES}?${search.query}`,
          )
          const body = { ...asked, incompleteSearch: true }
          await account.run.answerNext('GET', FILES, 200, body, 1, undefined, search.query)
        } else {
          clock = new ManualClock()
          await account.run.answerNext(
            'GET',
            FILES,
            null,
            undefined,
            UNTIL_CLEARED,
            undefined,
            search.query,
          )
        }
      }
      expect(await ask(found, text, [scope(under)], clock)).toBeNull()
    },
  )

  it('asks each query and joins the answers', async () => {
    const found = await corpora({ a: 'a', b: 'b notes' })
    await account.run.recordRequests()
    const out = await ask(found, 'notes', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/b.gdoc.json'])
    expect((await searched()).map(([text]) => text)).toEqual(['notes', 'otes'])
  })

  // Drive could not finish the listing, so it is not the directory, and
  // grep's own walk lists it again and may find more.
  it('reads every file after an unfinished listing', async () => {
    const found = await corpora({ a: 'a wombat' })
    const accessor = new GDocsAccessor({ tokenManager: account.tokenManager() })
    expect(
      await filesContaining(accessor, readdirOver(found, true), MIME, DOCS_WORDS, 'wombat', [
        scope('owned'),
      ]),
    ).toBeNull()
  })
})

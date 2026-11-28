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
import { mountKey } from '../../utils/key_prefix.ts'
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { FILES, GoogleAccount, type DriveListing } from '../../../tests/core/google/account.ts'

const MIME = 'application/vnd.google-apps.document'

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

// The account behind a mount at /gdocs, which keeps each listing as a command's
// walk does.
function mounted(): Workspace {
  const vfs = Object.assign(new GDocsVFS(account.config()), {
    accessor: new GDocsAccessor({ tokenManager: account.tokenManager() }),
  })
  return new Workspace({ '/gdocs/': vfs })
}

// A directory's children through the mount; a glob word, the children it
// matches.
async function readdir(path: PathSpec, ws: Workspace): Promise<string[]> {
  if (path.pattern === null) return (await ws.dispatch('readdir', path.virtual)) as string[]
  const words = (await ws.shell(`echo ${path.virtual}`)).stdoutText.trim().split(/\s+/)
  return words.length === 1 && words[0] === path.virtual ? [] : words
}

function stat(path: PathSpec, ws: Workspace): Promise<FileStat> {
  return ws.dispatch('stat', path.virtual) as Promise<FileStat>
}

function spec(virtual: string, pattern?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: pattern === undefined ? virtual : virtual.slice(0, virtual.lastIndexOf('/')),
    ...(pattern === undefined ? {} : { pattern }),
    vfsPath: mountKey(virtual, '/gdocs'),
  })
}

/** Make a doc named `name`, stamped `stamp`, and answer its id. */
async function made(name: string, stamp: string): Promise<string> {
  const id = await account.create(name, MIME)
  await account.patch(id, { modifiedTime: stamp })
  return id
}

/**
 * Answer the next listing with the fake's own listing of docs, each doc named
 * in `fieldsById` with those fields set: what the fake keeps no model of, as
 * another owner or a native file's size.
 */
async function answerListing(fieldsById: Record<string, Record<string, JsonValue>>): Promise<void> {
  const listing = await account.run.call<DriveListing>(
    'GET',
    `${FILES}?${new URLSearchParams({ q: `mimeType = '${MIME}'` }).toString()}`,
  )
  const files = listing.files.map((row) => ({ ...row, ...(fieldsById[row.id] ?? {}) }))
  await account.run.answerNext('GET', FILES, 200, { ...listing, files })
}

/** The query of each listing asked since recording started. */
async function listedQueries(): Promise<string[]> {
  return (await account.asked('GET', FILES)).map((r) => new URLSearchParams(r.query).get('q') ?? '')
}

describe('gdocs readdir', () => {
  it('pushes modified range to drive when pattern is a date glob', async () => {
    const ws = mounted()
    await account.run.recordRequests()
    await readdir(spec('/gdocs/owned/2026-05-*', '2026-05-*'), ws)
    const [q] = await listedQueries()
    expect(q).toContain("modifiedTime >= '2026-05-01T00:00:00Z'")
    expect(q).toContain("modifiedTime < '2026-06-01T00:00:00Z'")
  })

  it('omits modified range when no pattern', async () => {
    const ws = mounted()
    await account.run.recordRequests()
    await readdir(spec('/gdocs/owned'), ws)
    const [q] = await listedQueries()
    expect(q).not.toContain('modifiedTime')
  })

  it('omits modified range for non-date pattern', async () => {
    const ws = mounted()
    await account.run.recordRequests()
    await readdir(spec('/gdocs/owned/*foo*', '*foo*'), ws)
    const [q] = await listedQueries()
    expect(q).not.toContain('modifiedTime')
  })

  it('filtered listing does not clobber unfiltered cache', async () => {
    await made('MayDoc', '2026-05-15T00:00:00.000Z')
    await made('JanDoc', '2026-01-15T00:00:00.000Z')
    const ws = mounted()
    await account.run.recordRequests()
    await readdir(spec('/gdocs/owned/2026-05-*', '2026-05-*'), ws)
    const result = await readdir(spec('/gdocs/owned'), ws)
    expect(await listedQueries()).toHaveLength(2)
    expect(result.length).toBe(2)
  })

  it('answers a stat after a filtered listing', async () => {
    const may = await made('MayDoc', '2026-05-15T00:00:00.000Z')
    await answerListing({ [may]: { owners: [{ me: false }] } })
    const ws = mounted()
    await account.run.recordRequests()
    const listed = await readdir(spec('/gdocs/shared/2026-05-*', '2026-05-*'), ws)
    expect(listed.length).toBe(1)
    const matched = listed[0]
    if (matched === undefined) throw new Error('expected one match')
    const result = await stat(spec(matched), ws)
    // The filtered result is not the directory, but the rows it lists are
    // real, so the stat is answered from them.
    expect(result.extra.doc_id).toBe(may)
    expect((await account.log()).map(([name]) => name)).toEqual(['list'])
  })

  it('keeps entry size null, Drive source size lands in extra', async () => {
    const id = await made('My Doc', '2026-04-01T00:00:00.000Z')
    await answerListing({ [id]: { size: '1234' } })
    const ws = mounted()
    const listed = await readdir(spec('/gdocs/owned'), ws)
    // Drive's source size never becomes the row's size: the rendered
    // JSON length is unknown until read.
    const listedPath = listed[0]
    if (listedPath === undefined) throw new Error('expected one entry')
    const result = await stat(spec(listedPath), ws)
    expect(result.size).toBeNull()
    expect(result.extra.source_size).toBe(1234)
  })
})

describe('gdocs incomplete search', () => {
  it('does not cache a short listing as the directory', async () => {
    // Drive reporting a corpus it skipped means the listing is short.
    // Keeping it would pin the short listing until it expires, so a Shared
    // Drive document stays invisible long after the cause clears: the next
    // listing asks Drive again until one finishes.
    await made('Doc', '2026-05-15T00:00:00.000Z')
    const listing = await account.run.call<DriveListing>(
      'GET',
      `${FILES}?${new URLSearchParams({ q: `mimeType = '${MIME}'` }).toString()}`,
    )
    await account.run.answerNext('GET', FILES, 200, { ...listing, incompleteSearch: true }, 2)
    const ws = mounted()
    const owned = spec('/gdocs/owned')
    await account.run.recordRequests()
    const listed = await readdir(owned, ws)
    expect(listed).toHaveLength(1)
    await readdir(owned, ws)
    expect(await listedQueries()).toHaveLength(2)
    await readdir(owned, ws)
    await readdir(owned, ws)
    expect(await listedQueries()).toHaveLength(3)
  })
})

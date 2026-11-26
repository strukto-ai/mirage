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

// Mirror of python/tests/core/dropbox/test_api.py.

import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import { runWithWriteContext } from '../../cache/context.ts'
import type { Measured } from '../../cache/types.ts'
import { keptVersions } from '../../test-utils.ts'
import { isStaleWrite } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  MAX_SEARCH_MATCHES,
  SEARCH_PAGE,
  continueFolder,
  listFolder,
  movePath,
  refused,
  searchFiles,
} from './api.ts'

const LIST_ROUTE = '/2/files/list_folder'
const CONTINUE_ROUTE = '/2/files/list_folder/continue'
const SEARCH_ROUTE = '/2/files/search_v2'
const SEARCH_CONTINUE_ROUTE = '/2/files/search/continue_v2'
const MOVE_ROUTE = '/2/files/move_v2'

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function tm(): DropboxTokenManager {
  return account.accessor().tokenManager
}

function searchMatch(tag: string, lower: string, display: string): JsonValue {
  return {
    match_type: { '.tag': 'filename' },
    metadata: {
      '.tag': 'metadata',
      metadata: { '.tag': tag, path_lower: lower, path_display: display },
    },
  }
}

describe('listFolder', () => {
  it('normalizes the root to the empty path', async () => {
    await account.run.recordRequests()
    await listFolder(tm(), '/')
    const sent = await account.run.bodies('POST', LIST_ROUTE)
    expect(sent.map((body) => (body as { path: string }).path)).toEqual([''])
  })

  it('pages through continue', async () => {
    await account.put('/docs/a', new Uint8Array([97]))
    await account.put('/docs/b', new Uint8Array([98]))
    await account.run.recordRequests()
    const out = await listFolder(tm(), '/docs', { pageSize: 1 })
    expect(out.map((e) => e.name)).toEqual(['a', 'b'])
    const sent = await account.run.bodies('POST', CONTINUE_ROUTE)
    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0] as object)).toEqual(['cursor'])
  })
})

describe('searchFiles', () => {
  // Dropbox may repeat a match on a later page; pages it never repeats on
  // the fake are answered here.
  it('pages, dedups across pages, and skips folders', async () => {
    await account.run.answerNext('POST', SEARCH_ROUTE, 200, {
      matches: [searchMatch('file', '/a.txt', '/A.txt'), searchMatch('folder', '/dir', '/Dir')],
      has_more: true,
      cursor: 'c1',
    })
    await account.run.answerNext('POST', SEARCH_CONTINUE_ROUTE, 200, {
      matches: [searchMatch('file', '/a.txt', '/A.txt'), searchMatch('file', '/b.txt', '/B.txt')],
      has_more: false,
    })
    await account.run.recordRequests()
    const out = await searchFiles(tm(), 'needle', { path: '/docs' })
    expect(out.paths).toEqual([
      ['/a.txt', '/A.txt'],
      ['/b.txt', '/B.txt'],
    ])
    expect(out.truncated).toBe(false)
    expect(await account.run.bodies('POST', SEARCH_ROUTE)).toEqual([
      {
        query: 'needle',
        options: {
          max_results: SEARCH_PAGE,
          file_status: 'active',
          filename_only: false,
          path: '/docs',
        },
      },
    ])
    expect(await account.run.bodies('POST', SEARCH_CONTINUE_ROUTE)).toEqual([{ cursor: 'c1' }])
  })

  it('omits the path option for the account root', async () => {
    await account.run.recordRequests()
    const out = await searchFiles(tm(), 'needle')
    expect(out).toEqual({ paths: [], truncated: false })
    const [first] = (await account.run.bodies('POST', SEARCH_ROUTE)) as {
      options: Record<string, unknown>
    }[]
    expect('path' in (first?.options ?? {})).toBe(false)
  })

  // A first page that already holds 10,000 matches, with more to come: the
  // walk stops there.
  it('flags the 10,000-match ceiling as truncated', async () => {
    const matches = Array.from({ length: MAX_SEARCH_MATCHES }, (_, i) =>
      searchMatch('file', `/f${String(i)}.txt`, `/f${String(i)}.txt`),
    )
    await account.run.answerNext('POST', SEARCH_ROUTE, 200, {
      matches,
      has_more: true,
      cursor: 'c1',
    })
    await account.run.recordRequests()
    const out = await searchFiles(tm(), 'needle')
    expect(out.paths).toHaveLength(MAX_SEARCH_MATCHES)
    expect(out.truncated).toBe(true)
    expect(await account.run.bodies('POST', SEARCH_CONTINUE_ROUTE)).toEqual([])
  })
})

describe('continueFolder', () => {
  it('pages through continue', async () => {
    for (const name of ['a', 'b', 'c']) await account.put(`/docs/${name}`, new Uint8Array([120]))
    const first = await account.run.call<{ cursor: string }>('POST', LIST_ROUTE, {
      json: { path: '/docs', limit: 1 },
    })
    await account.run.recordRequests()
    const out = await continueFolder(tm(), first.cursor)
    expect(out.entries.map((e) => e.name)).toEqual(['b', 'c'])
    expect((await account.run.bodies('POST', CONTINUE_ROUTE))[0]).toEqual({ cursor: first.cursor })
    expect(['', first.cursor]).not.toContain(out.cursor)
  })
})

describe('movePath', () => {
  const entry = { '.tag': 'file', name: 'b' }
  // Anything but an object names no kind, so the rename keeps its subtree
  // drop; the transport reads an empty body as null.
  it.each([
    ['the moved entry', { metadata: entry }, entry],
    ['an empty body', null, {}],
    ['no metadata', {}, {}],
    ['null metadata', { metadata: null }, {}],
    ['string metadata', { metadata: 'b' }, {}],
    ['array metadata', { metadata: [] }, {}],
  ] as [string, JsonValue, JsonValue][])('reads %s', async (_label, reply, moved) => {
    await account.run.answerNext('POST', MOVE_ROUTE, 200, reply)
    expect(await movePath(tm(), '/a', '/b')).toEqual(moved)
  })

  it('answers the moved entry Dropbox names', async () => {
    await account.put('/a', new Uint8Array([97]))
    const moved = await movePath(tm(), '/a', '/b')
    const meta = await account.run.call('POST', '/2/files/get_metadata', { json: { path: '/b' } })
    expect(moved).toEqual(meta)
  })
})

interface LostCase {
  name: string
  summary: string
  outcome: 'lost' | 'gone' | 'other'
}

const LOST = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/fixtures/write/drive_lost_codes.json', import.meta.url),
    'utf-8',
  ),
) as { dropbox: LostCase[] }

async function refuse(
  err: DropboxApiError,
  sent: string | null,
): Promise<[Measured[], StaleWriteError | null]> {
  const { context, kept } = keptVersions('dropbox')
  const path = new PathSpec({ virtual: '/dbx/f', directory: '/dbx/', vfsPath: '/f' })
  const got = await runWithWriteContext('/dbx/', context, () =>
    refused(path, err, { kind: 'match', version: 's1' }, sent),
  )
  return [kept, got]
}

describe('refused', () => {
  const rows = LOST.dropbox.flatMap((c) => [[c.name, 'e1', c] as const, [c.name, null, c] as const])
  it.each(rows)(
    'reads Dropbox answers like the shared table: %s, sent %s',
    async (_name, sent, c) => {
      const [kept, got] = await refuse(new DropboxApiError('x', 409, c.summary), sent)
      if (sent === null || c.outcome === 'other') expect([kept, got]).toEqual([[], null])
      else {
        expect(isStaleWrite(got)).toBe(true)
        expect(kept).toEqual(['s1'])
      }
    },
  )
})

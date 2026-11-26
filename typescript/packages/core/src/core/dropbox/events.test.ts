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
import { type Delta, FileChangeKind, PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DropboxDeltaHook } from './events.ts'

const ROOT = new PathSpec({ virtual: '/m', directory: '/m', vfsPath: '' })
const C = FileChangeKind.CREATE
const U = FileChangeKind.UPDATE
const D = FileChangeKind.DELETE
const LATEST_ROUTE = '/2/files/list_folder/get_latest_cursor'
const CONTINUE_ROUTE = '/2/files/list_folder/continue'

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

function hook(): DropboxDeltaHook {
  return new DropboxDeltaHook(account.accessor('/team'))
}

function file(pathDisplay: string, digest: string): JsonValue {
  return { '.tag': 'file', name: '', path_display: pathDisplay, content_hash: digest }
}

function row(tag: 'folder' | 'deleted', pathDisplay: string): JsonValue {
  return { '.tag': tag, name: '', path_display: pathDisplay }
}

function saved(delta: Delta): { dropbox: { cursor: string; seen: Record<string, string> } } {
  return JSON.parse(delta.checkpoint ?? '') as {
    dropbox: { cursor: string; seen: Record<string, string> }
  }
}

function pairs(delta: Delta): [string, string][] {
  return delta.changes.map((change) => [change.kind, change.path.virtual])
}

describe('DropboxDeltaHook', () => {
  // Twin of test_each_ping_replays_the_cursor_and_lists_nothing: a baseline
  // takes a cursor at the present; each pull after it is one continue from
  // the stored cursor. A path seen before is an UPDATE, or nothing when its
  // content hash did not move; the root is stripped however the server cases
  // it, and the rest keeps the server's casing. The fake keeps one casing, so
  // Dropbox's pages are answered here, and its baseline cursor too, so the
  // first continue's cursor is known.
  it('replays the cursor on each ping and lists nothing', async () => {
    await account.mkdir('/team')
    await account.run.answerNext('POST', LATEST_ROUTE, 200, { cursor: 'c1' })
    const replies = [
      { entries: [file('/Team/Docs/A.txt', 'h1'), row('folder', '/TEAM/sub')], cursor: 'c2' },
      { entries: [file('/team/Docs/A.txt', 'h2'), file('/team/Docs/A.txt', 'h2')], cursor: 'c3' },
      { entries: [file('/team/sub/b.txt', 'h3'), row('deleted', '/team/sub')], cursor: 'c4' },
    ]
    for (const reply of replies) {
      await account.run.answerNext('POST', CONTINUE_ROUTE, 200, { ...reply, has_more: false })
    }
    await account.run.recordRequests()
    const target = hook()
    let delta = await target.pull(ROOT, null)
    const got: [string, string][][] = []
    for (const reply of replies) {
      delta = await target.pull(ROOT, delta.checkpoint)
      got.push(pairs(delta))
      expect(delta.checkpoint).toContain(reply.cursor)
    }
    expect(got).toEqual([
      [
        [C, '/m/Docs/A.txt'],
        [C, '/m/sub'],
      ],
      [[U, '/m/Docs/A.txt']],
      [
        [C, '/m/sub/b.txt'],
        [D, '/m/sub'],
      ],
    ])
    const baseline = await account.run.bodies('POST', LATEST_ROUTE)
    expect(baseline).toEqual([expect.objectContaining({ path: '/team' })])
    const replayed = await account.run.bodies('POST', CONTINUE_ROUTE)
    expect(replayed.map((body) => (body as { cursor: string }).cursor)).toEqual(['c1', 'c2', 'c3'])
    expect(saved(delta).dropbox.seen).toEqual({ 'Docs/A.txt': 'h2' })
  })

  // Twin of test_a_reset_or_a_root_that_comes_back_reports_the_root: a cursor
  // Dropbox resets, and a root it could not find that is back, both leave the
  // root UNKNOWN with a fresh cursor, never a walk.
  it('reports the root after a reset or a root that comes back', async () => {
    const target = hook()
    await account.run.recordRequests()
    const baseline = await target.pull(ROOT, null)
    await account.mkdir('/team')
    const back = await target.pull(ROOT, baseline.checkpoint)
    await account.run.answerNext('POST', CONTINUE_ROUTE, 409, { error_summary: 'reset/..' })
    const renewed = await target.pull(ROOT, back.checkpoint)
    expect(saved(baseline).dropbox.cursor).toBe('')
    expect(pairs(back)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    expect(pairs(renewed)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    expect(await account.run.bodies('POST', LATEST_ROUTE)).toHaveLength(3)
    expect(['', saved(back).dropbox.cursor]).not.toContain(saved(renewed).dropbox.cursor)
  })
})

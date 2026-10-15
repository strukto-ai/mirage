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
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, latestCursor: vi.fn(), continueFolder: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { type Delta, FileChangeKind, PathSpec } from '../../types.ts'
import * as api from './api.ts'
import type { DropboxEntry } from './api.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import { DropboxDeltaHook } from './watch.ts'

const ROOT = new PathSpec({ virtual: '/m', directory: '/m', vfsPath: '' })
const C = FileChangeKind.CREATE
const U = FileChangeKind.UPDATE
const D = FileChangeKind.DELETE

function hook(): DropboxDeltaHook {
  return new DropboxDeltaHook(
    new DropboxAccessor({ tokenManager: {} as DropboxTokenManager, rootPath: '/team' }),
  )
}

function file(pathDisplay: string, digest: string): DropboxEntry {
  return { '.tag': 'file', name: '', path_display: pathDisplay, content_hash: digest }
}

function row(tag: 'folder' | 'deleted', pathDisplay: string): DropboxEntry {
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
  // it, and the rest keeps the server's casing.
  it('replays the cursor on each ping and lists nothing', async () => {
    vi.mocked(api.latestCursor).mockReset().mockResolvedValue('c1')
    const replies = [
      { entries: [file('/Team/Docs/A.txt', 'h1'), row('folder', '/TEAM/sub')], cursor: 'c2' },
      { entries: [file('/team/Docs/A.txt', 'h2'), file('/team/Docs/A.txt', 'h2')], cursor: 'c3' },
      { entries: [file('/team/sub/b.txt', 'h3'), row('deleted', '/team/sub')], cursor: 'c4' },
    ]
    const replay = vi.mocked(api.continueFolder).mockReset()
    for (const reply of replies) replay.mockResolvedValueOnce(reply)
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
    expect(replay.mock.calls.map((call) => call[1])).toEqual(['c1', 'c2', 'c3'])
    expect(api.latestCursor).toHaveBeenCalledTimes(1)
    expect(saved(delta).dropbox.seen).toEqual({ 'Docs/A.txt': 'h2' })
  })

  // Twin of test_a_reset_or_a_root_that_comes_back_reports_the_root: a cursor
  // Dropbox resets, and a root it could not find that is back, both leave the
  // root UNKNOWN with a fresh cursor, never a walk.
  it('reports the root after a reset or a root that comes back', async () => {
    vi.mocked(api.latestCursor)
      .mockReset()
      .mockRejectedValueOnce(new DropboxApiError('409', 409, 'path/not_found/..'))
      .mockResolvedValueOnce('c1')
      .mockResolvedValueOnce('c2')
    vi.mocked(api.continueFolder)
      .mockReset()
      .mockRejectedValue(new DropboxApiError('409', 409, 'reset/..'))
    const target = hook()
    const baseline = await target.pull(ROOT, null)
    const back = await target.pull(ROOT, baseline.checkpoint)
    const renewed = await target.pull(ROOT, back.checkpoint)
    expect(saved(baseline).dropbox.cursor).toBe('')
    expect(pairs(back)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    expect(pairs(renewed)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    expect(saved(renewed).dropbox.cursor).toBe('c2')
  })
})

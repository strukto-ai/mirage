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
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, eventsNow: vi.fn(), eventsSince: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { FileChangeKind, PathSpec, type Delta, type JsonValue } from '../../types.ts'
import * as api from './api.ts'
import type { BoxEvent, BoxItem } from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { BoxDeltaHook, BoxEventHook } from './events.ts'

const STUB_TM = {} as BoxTokenManager
const ALL_FILES = { type: 'folder' as const, id: '0', name: 'All Files' }
const TEAM = { type: 'folder' as const, id: '10', name: 'team' }
const TRASH = { type: 'folder' as const, id: '1', name: 'Trash' }
type Parent = typeof ALL_FILES

function accessor(rootFolderId?: string): BoxAccessor {
  return new BoxAccessor({
    tokenManager: STUB_TM,
    ...(rootFolderId === undefined ? {} : { rootFolderId }),
  })
}

function root(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/box' : `/box/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

function file(id: string, name: string, sha1: string, ...parents: Parent[]): BoxItem {
  return {
    type: 'file',
    id,
    name,
    sha1,
    size: 4,
    modified_at: '2026-09-20T10:00:00-07:00',
    path_collection: { total_count: parents.length + 1, entries: [ALL_FILES, ...parents] },
  } as BoxItem
}

function folder(id: string, name: string, ...parents: Parent[]): BoxItem {
  return {
    type: 'folder',
    id,
    name,
    path_collection: { total_count: parents.length + 1, entries: [ALL_FILES, ...parents] },
  } as BoxItem
}

function trashed(item: BoxItem): BoxItem {
  return { ...item, path_collection: { total_count: 1, entries: [TRASH] } } as BoxItem
}

function event(
  eventType: string,
  source: BoxItem,
  opts: { eventId?: string; createdAt?: string } = {},
): BoxEvent {
  return {
    type: 'event',
    event_id: opts.eventId ?? `${eventType}-${source.id}`,
    event_type: eventType,
    source,
    ...(opts.createdAt === undefined ? {} : { created_at: opts.createdAt }),
  }
}

class FakeBox {
  pending: BoxEvent[] = []
  position = 100
  calls: string[] = []

  constructor() {
    vi.mocked(api.eventsNow).mockImplementation(() => {
      this.calls.push('now')
      return Promise.resolve(String(this.position))
    })
    vi.mocked(api.eventsSince).mockImplementation((_tm, position) => {
      this.calls.push(`since ${position}`)
      const entries = this.pending
      this.pending = []
      this.position += entries.length
      return Promise.resolve({ entries, position: String(this.position) })
    })
  }
}

function pairs(delta: Delta): string[] {
  return delta.changes.map((c) => `${c.kind} ${c.path.virtual}`)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BoxDeltaHook', () => {
  // Twin of test_baseline_takes_the_stream_head_and_lists_nothing.
  it('takes the stream head on a baseline and lists nothing', async () => {
    const fake = new FakeBox()
    const delta = await new BoxDeltaHook(accessor()).pull(root(), null)
    expect(delta.changes).toEqual([])
    expect(fake.calls).toEqual(['now'])
  })

  // Twin of test_each_ping_maps_the_events_since_the_last_position: the
  // places an event names are remembered in the checkpoint, so a later pull
  // follows an item it saw: an upload of a known file is an UPDATE, its
  // rename a MOVE, and its trash a DELETE where it was.
  it('maps the events since the last position on each ping', async () => {
    const fake = new FakeBox()
    const hook = new BoxDeltaHook(accessor('10'))
    const a = file('1', 'a.txt', 's1', TEAM)
    const renamed = { ...a, name: 'b.txt' } as BoxItem
    const steps = [
      [event('ITEM_UPLOAD', a)],
      [event('ITEM_UPLOAD', a, { eventId: 'e2' })],
      [event('ITEM_RENAME', renamed)],
      [event('ITEM_TRASH', trashed(renamed))],
    ]
    let delta = await hook.pull(root(), null)
    const got: string[][] = []
    for (const events of steps) {
      fake.pending = events
      delta = await hook.pull(root(), delta.checkpoint)
      got.push(pairs(delta))
    }
    expect(got).toEqual([
      ['create /box/a.txt'],
      ['update /box/a.txt'],
      ['move /box/b.txt'],
      ['delete /box/b.txt'],
    ])
  })

  // Twin of test_a_move_out_of_the_event_root_is_a_delete_where_it_was.
  it('reports a move out of the event root as a delete where it was', async () => {
    const fake = new FakeBox()
    const hook = new BoxDeltaHook(accessor('10'))
    const sub = { type: 'folder' as const, id: '20', name: 'sub' }
    let delta = await hook.pull(root('sub'), null)
    fake.pending = [event('ITEM_UPLOAD', file('1', 'a.txt', 's1', TEAM, sub))]
    delta = await hook.pull(root('sub'), delta.checkpoint)
    fake.pending = [event('ITEM_MOVE', file('1', 'a.txt', 's1', TEAM))]
    delta = await hook.pull(root('sub'), delta.checkpoint)
    expect(pairs(delta)).toEqual(['delete /box/sub/a.txt'])
  })

  // Twin of test_events_apply_once_each_in_the_order_they_happened.
  it('applies events once each in the order they happened', async () => {
    const fake = new FakeBox()
    const hook = new BoxDeltaHook(accessor('10'))
    const a = file('1', 'a.txt', 's1', TEAM)
    let delta = await hook.pull(root(), null)
    fake.pending = [
      event('ITEM_RENAME', { ...a, name: 'b.txt' } as BoxItem, {
        eventId: 'e2',
        createdAt: '2026-09-20T10:00:02Z',
      }),
      event('ITEM_UPLOAD', a, { eventId: 'e1', createdAt: '2026-09-20T10:00:01Z' }),
      event('ITEM_UPLOAD', a, { eventId: 'e1', createdAt: '2026-09-20T10:00:01Z' }),
    ]
    delta = await hook.pull(root(), delta.checkpoint)
    expect(pairs(delta)).toEqual(['create /box/a.txt', 'move /box/b.txt'])
  })

  // Twin of test_a_position_older_than_the_replay_window_is_unknown: Box
  // replays whatever it still keeps from a stale position, so the root is
  // UNKNOWN and the stream starts again at the present.
  it('calls a position older than the replay window unknown', async () => {
    const fake = new FakeBox()
    const hook = new BoxDeltaHook(accessor())
    const delta = await hook.pull(root(), null)
    const state = JSON.parse(delta.checkpoint ?? '{}') as { box: { read: string } }
    state.box.read = '2020-01-01T00:00:00+00:00'
    fake.pending = [event('ITEM_UPLOAD', file('1', 'a.txt', 's1', TEAM))]
    const stale = await hook.pull(root(), JSON.stringify(state))
    expect(pairs(stale)).toEqual(['unknown /box'])
    expect(fake.calls).toEqual(['now', 'now'])
  })
})

describe('BoxEventHook', () => {
  async function mapped(hook: BoxEventHook, eventType: string, source: BoxItem): Promise<string[]> {
    const out = await hook.toEvents(root(), eventType, event(eventType, source) as JsonValue)
    return out.map(
      (c) =>
        `${c.kind} ${c.path.virtual}${c.previousPath === null ? '' : ` <- ${c.previousPath.virtual}`}`,
    )
  }

  it('tracks ids across events', async () => {
    const hook = new BoxEventHook(accessor())
    expect(await mapped(hook, 'ITEM_UPLOAD', file('1', 'a.txt', 's1'))).toEqual([
      'create /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_UPLOAD', file('1', 'a.txt', 's2'))).toEqual([
      'update /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_RENAME', file('1', 'b.txt', 's2'))).toEqual([
      'move /box/b.txt <- /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_TRASH', trashed(file('1', 'b.txt', 's2')))).toEqual([
      'delete /box/b.txt',
    ])
  })

  it('maps a move of an unknown item to UNKNOWN on its parent', async () => {
    const hook = new BoxEventHook(accessor())
    expect(await mapped(hook, 'ITEM_MOVE', file('7', 'a.txt', 's7', TEAM))).toEqual([
      `${FileChangeKind.UNKNOWN} /box/team`,
    ])
  })

  it('ignores items outside the mount', async () => {
    const hook = new BoxEventHook(accessor('10'))
    const other = { type: 'folder' as const, id: '11', name: 'other' }
    expect(await mapped(hook, 'ITEM_UPLOAD', file('5', 'n.txt', 's5', other))).toEqual([])
    expect(await mapped(hook, 'ITEM_UPLOAD', file('6', 'm.txt', 's6', TEAM))).toEqual([
      'create /box/m.txt',
    ])
  })

  it('maps the places a folder leaves or lands on to UNKNOWN', async () => {
    const hook = new BoxEventHook(accessor())
    expect(await mapped(hook, 'ITEM_CREATE', folder('10', 'team'))).toEqual(['create /box/team'])
    expect(await mapped(hook, 'ITEM_COPY', folder('20', 'copy'))).toEqual(['unknown /box/copy'])
    expect(await mapped(hook, 'ITEM_RENAME', folder('10', 'crew'))).toEqual([
      'unknown /box/team',
      'unknown /box/crew',
    ])
    expect(await mapped(hook, 'ITEM_TRASH', trashed(folder('10', 'crew')))).toEqual([
      'unknown /box/crew',
    ])
  })

  it('moves and forgets what a folder holds along with it', async () => {
    const hook = new BoxEventHook(accessor())
    const crew = { type: 'folder' as const, id: '10', name: 'crew' }
    await mapped(hook, 'ITEM_CREATE', folder('10', 'team'))
    await mapped(hook, 'ITEM_UPLOAD', file('1', 'a.txt', 's1', TEAM))
    await mapped(hook, 'ITEM_UPLOAD', file('2', 'b.txt', 's2', TEAM))
    await mapped(hook, 'ITEM_RENAME', folder('10', 'crew'))
    expect(await mapped(hook, 'ITEM_TRASH', trashed(file('1', 'a.txt', 's1')))).toEqual([
      'delete /box/crew/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_UPLOAD', file('2', 'b.txt', 's3', crew))).toEqual([
      'update /box/crew/b.txt',
    ])
    await mapped(hook, 'ITEM_TRASH', trashed(folder('10', 'crew')))
    expect(await mapped(hook, 'ITEM_TRASH', trashed(file('2', 'b.txt', 's3')))).toEqual([])
  })

  it('maps a trash of the mount root to UNKNOWN on the whole mount', async () => {
    const hook = new BoxEventHook(accessor('10'))
    expect(await mapped(hook, 'ITEM_TRASH', trashed(folder('10', 'team')))).toEqual([
      'unknown /box',
    ])
    expect(await mapped(hook, 'ITEM_RENAME', folder('10', 'crew'))).toEqual([])
  })
})

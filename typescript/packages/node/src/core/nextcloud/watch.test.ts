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

import { FileChangeKind, type JsonValue, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import type { NextcloudConfig } from '../../vfs/nextcloud/config.ts'
import { NextcloudEventHook } from './watch.ts'

const ROOT = PathSpec.fromStrPath('/nc', '')
const NODE = 'OCP\\Files\\Events\\Node\\'

function node(path: string): JsonValue {
  return { event: { node: { path } } }
}

function renamed(source: string, target: string): JsonValue {
  return { event: { source: { path: source }, target: { path: target } } }
}

// Twin of test_node_events_map_below_the_mounted_folder: the mount is rooted
// at the folder its URL names; a node outside it maps nothing, and a rename
// across its edge is a create or a delete.
describe('NextcloudEventHook', () => {
  it.each([
    ['https://nc.test/remote.php/dav/files/ada/Work', undefined],
    ['https://nc.test/remote.php/webdav/Work/', 'ada'],
  ])('maps node events below the mounted folder of %s', async (url, username) => {
    const hook = new NextcloudEventHook(new NextcloudAccessor({ url, username } as NextcloudConfig))
    const deliveries: [string, JsonValue][] = [
      ['NodeCreatedEvent', node('/ada/files/Work/a.txt')],
      ['NodeWrittenEvent', node('/ada/files/Work/a.txt')],
      ['NodeDeletedEvent', node('/ada/files/Work/sub')],
      ['NodeCreatedEvent', node('/ada/files/Other/x.txt')],
      ['NodeCreatedEvent', node('/bob/files/Work/x.txt')],
      ['NodeRenamedEvent', renamed('/ada/files/Work/a.txt', '/ada/files/Work/b.txt')],
      ['NodeRenamedEvent', renamed('/ada/files/Other/c.txt', '/ada/files/Work/c.txt')],
      ['NodeRenamedEvent', renamed('/ada/files/Work/c.txt', '/ada/files/Other/c.txt')],
      ['NodeShareEvent', node('/ada/files/Work/a.txt')],
    ]
    const changes: [string, string, string | null][] = []
    for (const [name, payload] of deliveries) {
      for (const event of await hook.toEvents(ROOT, NODE + name, payload)) {
        changes.push([event.kind, event.path.virtual, event.previousPath?.virtual ?? null])
      }
    }
    expect(changes).toEqual([
      [FileChangeKind.CREATE, '/nc/a.txt', null],
      [FileChangeKind.UPDATE, '/nc/a.txt', null],
      [FileChangeKind.DELETE, '/nc/sub', null],
      [FileChangeKind.MOVE, '/nc/b.txt', '/nc/a.txt'],
      [FileChangeKind.CREATE, '/nc/c.txt', null],
      [FileChangeKind.DELETE, '/nc/c.txt', null],
    ])
  })

  // Twin of test_a_folder_above_the_mount_root_moves_the_root: removing or
  // renaming away a folder above the root removes the root; one made or
  // renamed into place leaves it unknown; its own writes say nothing about
  // the mount.
  it('moves the root with a folder above it', async () => {
    const hook = new NextcloudEventHook(
      new NextcloudAccessor({
        url: 'https://nc.test/remote.php/dav/files/ada/Projects/Work',
      } as NextcloudConfig),
    )
    const deliveries: [string, JsonValue][] = [
      ['NodeDeletedEvent', node('/ada/files/Projects')],
      ['NodeRenamedEvent', renamed('/ada/files/Projects', '/ada/files/Old')],
      ['NodeRenamedEvent', renamed('/ada/files/New', '/ada/files/Projects')],
      ['NodeCreatedEvent', node('/ada/files/Projects')],
      ['NodeWrittenEvent', node('/ada/files/Projects')],
      ['NodeDeletedEvent', node('/ada/files/Projects2')],
    ]
    const changes: [string, string][] = []
    for (const [name, payload] of deliveries) {
      for (const event of await hook.toEvents(ROOT, NODE + name, payload)) {
        changes.push([event.kind, event.path.virtual])
      }
    }
    expect(changes).toEqual([
      [FileChangeKind.DELETE, '/nc'],
      [FileChangeKind.DELETE, '/nc'],
      [FileChangeKind.UNKNOWN, '/nc'],
      [FileChangeKind.UNKNOWN, '/nc'],
    ])
  })
})

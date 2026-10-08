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

import { describe, expect, it } from 'vitest'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { MountEntry } from '@struktoai/mirage-core/workspace/mount/mount'
import { DatabricksVolumeVFS } from './databricks_volume/databricks_volume.ts'
import { DiscordVFS } from './discord/discord.ts'
import { DiskVFS } from './disk/disk.ts'
import { EmailVFS } from './email/email.ts'
import { HfBucketsVFS } from './hf_buckets/hf_buckets.ts'
import { LanceDBVFS } from './lancedb/lancedb.ts'
import { MongoDBVFS } from './mongodb/mongodb.ts'
import { NotionVFS } from './notion/notion.ts'
import { PostgresVFS } from './postgres/postgres.ts'
import { SlackVFS } from './slack/slack.ts'
import { SSHVFS } from './ssh/ssh.ts'

// Every backend's op surface as the door sees it, pinned when the op tables
// became VFS methods. A diff here is a lost or gained op unless the change is
// deliberate. A class is probed with the base facts, so a renderer an
// instance declares is not counted here.
const DOOR_OPS = [
  'read',
  'readdir',
  'stat',
  'glob',
  'write',
  'append',
  'pwrite',
  'create',
  'mkdir',
  'unlink',
  'rmdir',
  'rename',
  'truncate',
  'setattr',
]

function served(cls: { prototype: BaseVFS }): string[] {
  const probe = Object.assign(Object.create(cls.prototype) as BaseVFS, new BaseVFS())
  const mount = new MountEntry({ prefix: '/', vfs: probe })
  return DOOR_OPS.filter((op) => mount.answers(op)).sort()
}

const SERVED: [string, { prototype: BaseVFS }, string[]][] = [
  [
    'databricks_volume',
    DatabricksVolumeVFS,
    [
      'append',
      'create',
      'glob',
      'mkdir',
      'pwrite',
      'read',
      'readdir',
      'rename',
      'rmdir',
      'stat',
      'unlink',
      'write',
    ],
  ],
  ['discord', DiscordVFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'disk',
    DiskVFS,
    [
      'append',
      'create',
      'glob',
      'mkdir',
      'pwrite',
      'read',
      'readdir',
      'rename',
      'rmdir',
      'setattr',
      'stat',
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['email', EmailVFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'hf_buckets',
    HfBucketsVFS,
    ['append', 'create', 'glob', 'mkdir', 'pwrite', 'read', 'readdir', 'stat', 'unlink', 'write'],
  ],
  ['lancedb', LanceDBVFS, ['glob', 'read', 'readdir', 'stat']],
  ['mongodb', MongoDBVFS, ['glob', 'read', 'readdir', 'stat']],
  ['notion', NotionVFS, ['glob', 'read', 'readdir', 'stat']],
  ['postgres', PostgresVFS, ['glob', 'read', 'readdir', 'stat']],
  ['slack', SlackVFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'ssh',
    SSHVFS,
    [
      'append',
      'create',
      'glob',
      'mkdir',
      'pwrite',
      'read',
      'readdir',
      'rename',
      'rmdir',
      'setattr',
      'stat',
      'truncate',
      'unlink',
      'write',
    ],
  ],
]

describe('the door serves each backend its functions', () => {
  it.each(SERVED)('%s', (_name, cls, expected) => {
    expect(served(cls)).toEqual([...expected].sort())
  })
})

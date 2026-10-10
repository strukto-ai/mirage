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
import { BaseVFS } from './base.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { BoxVFS } from './box/box.ts'
import { ChromaVFS } from './chroma/chroma.ts'
import { DropboxVFS } from './dropbox/dropbox.ts'
import { GCalVFS } from './gcal/gcal.ts'
import { GDocsVFS } from './gdocs/gdocs.ts'
import { GDriveVFS } from './gdrive/gdrive.ts'
import { GitHubVFS } from './github/github.ts'
import { GmailVFS } from './gmail/gmail.ts'
import { GSheetsVFS } from './gsheets/gsheets.ts'
import { GSlidesVFS } from './gslides/gslides.ts'
import { HistoryViewVFS } from './history/history.ts'
import { LangfuseVFS } from './langfuse/langfuse.ts'
import { LinearVFS } from './linear/linear.ts'
import { Mem0VFS } from './mem0/mem0.ts'
import { OneDriveVFS } from './onedrive/onedrive.ts'
import { QdrantVFS } from './qdrant/qdrant.ts'
import { RAMVFS } from './ram/ram.ts'
import { RedisResourceBase } from './redis/redis.ts'
import { SharePointVFS } from './sharepoint/sharepoint.ts'
import { TrelloVFS } from './trello/trello.ts'

// Every backend's op surface as the dispatcher sees it, pinned when the op tables
// became VFS methods. A diff here is a lost or gained op unless the change is
// deliberate. A class is probed with the base facts, so a renderer an
// instance declares is not counted here.
const DISPATCH_OPS = [
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
  return DISPATCH_OPS.filter((op) => mount.answers(op)).sort()
}

const SERVED: [string, { prototype: BaseVFS }, string[]][] = [
  [
    'box',
    BoxVFS,
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
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['chroma', ChromaVFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'dropbox',
    DropboxVFS,
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
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['gcal', GCalVFS, ['glob', 'read', 'readdir', 'stat', 'unlink']],
  ['gdocs', GDocsVFS, ['glob', 'readdir', 'stat', 'unlink']],
  [
    'gdrive',
    GDriveVFS,
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
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['github', GitHubVFS, ['glob', 'read', 'readdir', 'stat']],
  ['gmail', GmailVFS, ['glob', 'read', 'readdir', 'stat']],
  ['gsheets', GSheetsVFS, ['glob', 'readdir', 'stat', 'unlink']],
  ['gslides', GSlidesVFS, ['glob', 'readdir', 'stat', 'unlink']],
  ['history', HistoryViewVFS, ['glob', 'read', 'readdir', 'stat']],
  ['langfuse', LangfuseVFS, ['glob', 'read', 'readdir', 'stat']],
  ['linear', LinearVFS, ['glob', 'read', 'readdir', 'stat']],
  ['mem0', Mem0VFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'onedrive',
    OneDriveVFS,
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
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['qdrant', QdrantVFS, ['glob', 'read', 'readdir', 'stat']],
  [
    'ram',
    RAMVFS,
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
  [
    'redis',
    RedisResourceBase,
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
  [
    'sharepoint',
    SharePointVFS,
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
      'truncate',
      'unlink',
      'write',
    ],
  ],
  ['trello', TrelloVFS, ['glob', 'read', 'readdir', 'stat']],
]

describe('the dispatcher serves each backend its functions', () => {
  it.each(SERVED)('%s', (_name, cls, expected) => {
    expect(served(cls)).toEqual([...expected].sort())
  })
})

// A Google editor renders its one file kind; it stores no bytes to read.
describe('the Google editors render their files', () => {
  const config = { clientId: 'id', clientSecret: 's', refreshToken: 'rt' }
  it.each([
    ['gdocs', new GDocsVFS(config), ['.gdoc.json']],
    ['gsheets', new GSheetsVFS(config), ['.gsheet.json']],
    ['gslides', new GSlidesVFS(config), ['.gslide.json']],
  ] as const)('%s', (_name, vfs, filetypes) => {
    expect(Object.keys(vfs.renderers)).toEqual(filetypes)
    expect(vfs.supports('read')).toBe(false)
  })
})

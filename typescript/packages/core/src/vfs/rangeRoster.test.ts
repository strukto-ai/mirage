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
import type { BaseVFS } from './base.ts'
import { BoxVFS } from './box/box.ts'
import { DatabricksVolumeVFSBase } from './databricks_volume/databricks_volume.ts'
import { DifyVFS } from './dify/dify.ts'
import { DiscordVFSBase } from './discord/discord.ts'
import { DropboxVFS } from './dropbox/dropbox.ts'
import { GDriveVFS } from './gdrive/gdrive.ts'
import { NotionVFSBase } from './notion/notion.ts'
import { OneDriveVFS } from './onedrive/onedrive.ts'
import { PostgresVFSBase } from './postgres/postgres.ts'
import { RAMVFS } from './ram/ram.ts'
import { RedisResourceBase } from './redis/redis.ts'
import { S3VFSBase } from './s3/s3.ts'
import { SharePointVFS } from './sharepoint/sharepoint.ts'
import { SlackVFSBase } from './slack/slack.ts'

// Every backend that takes the window itself instead of leaving it to the
// read-and-slice fallback. Most push it down to the store (one ranged GET
// rather than the whole object); the ones that render their content or
// already hold it in memory take the window right after building the bytes,
// so a windowed read is answered the same way everywhere. Losing an entry
// here is not a failure anywhere else: the fallback keeps the backend
// correct while it silently starts reading whole objects again. Python pins
// the same roster in tests/vfs/test_read_range_roster.py; the node package
// pins its own backends beside them. A backend the node and browser packages
// build over their own transport is pinned here by its shared base.
const NATIVE: [string, () => BaseVFS][] = [
  ['box', () => new BoxVFS({ accessToken: 'fake' })],
  ['databricks_volume', () => new DatabricksVolumeVFSBase()],
  ['dify', () => new DifyVFS({ apiKey: 'k', baseUrl: 'http://dify.test', datasetId: 'd' })],
  ['discord', () => new DiscordVFSBase()],
  ['dropbox', () => new DropboxVFS({ clientId: 'i', refreshToken: 'r' })],
  ['gdrive', () => new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' })],
  ['onedrive', () => new OneDriveVFS({ accessToken: 'tok' })],
  ['ram', () => new RAMVFS()],
  ['redis', () => new RedisResourceBase({ url: 'redis://test' } as never)],
  ['s3', () => new S3VFSBase()],
  ['sharepoint', () => new SharePointVFS({ accessToken: 'tok' })],
  ['slack', () => new SlackVFSBase()],
]

const SLICED: [string, () => BaseVFS][] = [
  ['notion', () => new NotionVFSBase()],
  ['postgres', () => new PostgresVFSBase()],
]

describe('native read range roster', () => {
  it.each(NATIVE)('%s reads its own window', (_name, build) => {
    expect(build().readsRanges).toBe(true)
  })

  it.each(SLICED)('%s leaves the window to the fallback', (_name, build) => {
    expect(build().readsRanges).toBe(false)
  })
})

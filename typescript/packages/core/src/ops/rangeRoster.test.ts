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
import { BOX_IO } from '../commands/builtin/box/io.ts'
import { DATABRICKS_VOLUME_IO } from '../commands/builtin/databricks_volume/io.ts'
import { DIFY_IO } from '../commands/builtin/dify/io.ts'
import { DISCORD_IO } from '../commands/builtin/discord/io.ts'
import { DROPBOX_IO } from '../commands/builtin/dropbox/io.ts'
import { GDRIVE_IO } from '../commands/builtin/gdrive/io.ts'
import { ONEDRIVE_IO } from '../commands/builtin/onedrive/io.ts'
import { S3_IO } from '../commands/builtin/s3/io.ts'
import { SHAREPOINT_IO } from '../commands/builtin/sharepoint/io.ts'
import { SLACK_IO } from '../commands/builtin/slack/io.ts'
import { RAM_IO } from '../commands/builtin/ram/io.ts'
import { REDIS_IO } from '../commands/builtin/redis/io.ts'
import { NOTION_IO } from '../commands/builtin/notion/io.ts'
import { POSTGRES_IO } from '../commands/builtin/postgres/io.ts'

// Every backend that takes the window itself instead of leaving it to the
// generic read-and-slice fallback. Most push it down to the store (one ranged
// GET rather than the whole object); the ones that render their content or
// already hold it in memory take the window right after building the bytes, so
// a windowed read is answered the same way everywhere. Losing an entry here is
// not a failure anywhere else: the fallback keeps the backend correct while it
// silently starts reading whole objects again. Python pins the same roster in
// tests/ops/test_read_range_roster.py.
const NATIVE = {
  box: BOX_IO,
  databricks_volume: DATABRICKS_VOLUME_IO,
  dify: DIFY_IO,
  discord: DISCORD_IO,
  ram: RAM_IO,
  redis: REDIS_IO,
  dropbox: DROPBOX_IO,
  gdrive: GDRIVE_IO,
  onedrive: ONEDRIVE_IO,
  s3: S3_IO,
  sharepoint: SHAREPOINT_IO,
  slack: SLACK_IO,
}

// Left to the generic read-and-slice fallback.
const SLICED = { notion: NOTION_IO, postgres: POSTGRES_IO }

describe('native read range roster', () => {
  it.each(Object.entries(NATIVE))('%s pushes the window down', (_name, io) => {
    expect(io.readRange).toBeDefined()
  })

  it.each(Object.entries(SLICED))('%s leaves the slot empty', (_name, io) => {
    expect(io.readRange).toBeUndefined()
  })
})

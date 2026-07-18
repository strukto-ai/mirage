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

import { expect, test } from 'vitest'

import { BOX_OPS } from './box/index.ts'
import { CHROMA_OPS } from './chroma/index.ts'
import { DATABRICKS_VOLUME_OPS } from './databricks_volume/index.ts'
import { DISCORD_OPS } from './discord/index.ts'
import { DROPBOX_OPS } from './dropbox/index.ts'
import { GDOCS_OPS } from './gdocs/index.ts'
import { GDRIVE_OPS } from './gdrive/index.ts'
import { GITHUB_OPS } from './github/index.ts'
import { GITHUB_CI_OPS } from './github_ci/index.ts'
import { GMAIL_OPS } from './gmail/index.ts'
import { GSHEETS_OPS } from './gsheets/index.ts'
import { GSLIDES_OPS } from './gslides/index.ts'
import { HISTORY_OPS } from './history/index.ts'
import { LANCEDB_OPS } from './lancedb/index.ts'
import { LANGFUSE_OPS } from './langfuse/index.ts'
import { LINEAR_OPS } from './linear/index.ts'
import { MONGODB_OPS } from './mongodb/index.ts'
import { NOTION_OPS } from './notion/index.ts'
import { POSTGRES_OPS } from './postgres/index.ts'
import { QDRANT_OPS } from './qdrant/index.ts'
import { RAM_OPS } from './ram/index.ts'
import { SLACK_OPS } from './slack/index.ts'
import { TRELLO_OPS } from './trello/index.ts'

// Golden snapshot of every backend's registered op surface, taken before
// the ops-layer refactor. Each row is [name, resource, filetype, write];
// filetype '' means no filetype binding. Any diff here is a registration
// regression unless the change is deliberate.

type Row = [string, string, string, boolean]

const TABLES = {
  box: BOX_OPS,
  chroma: CHROMA_OPS,
  databricks_volume: DATABRICKS_VOLUME_OPS,
  discord: DISCORD_OPS,
  dropbox: DROPBOX_OPS,
  gdocs: GDOCS_OPS,
  gdrive: GDRIVE_OPS,
  github: GITHUB_OPS,
  github_ci: GITHUB_CI_OPS,
  gmail: GMAIL_OPS,
  gsheets: GSHEETS_OPS,
  gslides: GSLIDES_OPS,
  history: HISTORY_OPS,
  lancedb: LANCEDB_OPS,
  langfuse: LANGFUSE_OPS,
  linear: LINEAR_OPS,
  mongodb: MONGODB_OPS,
  notion: NOTION_OPS,
  postgres: POSTGRES_OPS,
  qdrant: QDRANT_OPS,
  ram: RAM_OPS,
  slack: SLACK_OPS,
  trello: TRELLO_OPS,
}

const OPS_INVENTORY: Record<string, Row[]> = {
  box: [
    ['read', 'box', '', false],
    ['readdir', 'box', '', false],
    ['stat', 'box', '', false],
  ],
  chroma: [
    ['read', 'chroma', '', false],
    ['readdir', 'chroma', '', false],
    ['stat', 'chroma', '', false],
  ],
  databricks_volume: [
    ['create', 'databricks_volume', '', true],
    ['mkdir', 'databricks_volume', '', true],
    ['read', 'databricks_volume', '', false],
    ['readdir', 'databricks_volume', '', false],
    ['rename', 'databricks_volume', '', true],
    ['rmdir', 'databricks_volume', '', true],
    ['stat', 'databricks_volume', '', false],
    ['unlink', 'databricks_volume', '', true],
    ['write', 'databricks_volume', '', true],
  ],
  discord: [
    ['read', 'discord', '', false],
    ['readdir', 'discord', '', false],
    ['stat', 'discord', '', false],
  ],
  dropbox: [
    ['read', 'dropbox', '', false],
    ['readdir', 'dropbox', '', false],
    ['stat', 'dropbox', '', false],
  ],
  gdocs: [
    ['read', 'gdocs', '.gdoc.json', false],
    ['readdir', 'gdocs', '', false],
    ['stat', 'gdocs', '', false],
  ],
  gdrive: [
    ['create', 'gdrive', '', true],
    ['mkdir', 'gdrive', '', true],
    ['read', 'gdrive', '', false],
    ['readdir', 'gdrive', '', false],
    ['rename', 'gdrive', '', true],
    ['rmdir', 'gdrive', '', true],
    ['stat', 'gdrive', '', false],
    ['truncate', 'gdrive', '', true],
    ['unlink', 'gdrive', '', true],
    ['write', 'gdrive', '', true],
  ],
  github: [
    ['read', 'github', '', false],
    ['readdir', 'github', '', false],
    ['stat', 'github', '', false],
  ],
  github_ci: [
    ['read', 'github_ci', '', false],
    ['readdir', 'github_ci', '', false],
    ['stat', 'github_ci', '', false],
  ],
  gmail: [
    ['read', 'gmail', '', false],
    ['readdir', 'gmail', '', false],
    ['stat', 'gmail', '', false],
  ],
  gsheets: [
    ['read', 'gsheets', '.gsheet.json', false],
    ['readdir', 'gsheets', '', false],
    ['stat', 'gsheets', '', false],
  ],
  gslides: [
    ['read', 'gslides', '.gslide.json', false],
    ['readdir', 'gslides', '', false],
    ['stat', 'gslides', '', false],
  ],
  history: [
    ['read', 'history', '', false],
    ['readdir', 'history', '', false],
    ['stat', 'history', '', false],
  ],
  lancedb: [
    ['read', 'lancedb', '', false],
    ['readdir', 'lancedb', '', false],
    ['stat', 'lancedb', '', false],
  ],
  langfuse: [
    ['read', 'langfuse', '', false],
    ['readdir', 'langfuse', '', false],
    ['stat', 'langfuse', '', false],
  ],
  linear: [
    ['read', 'linear', '', false],
    ['readdir', 'linear', '', false],
    ['stat', 'linear', '', false],
  ],
  mongodb: [
    ['read', 'mongodb', '', false],
    ['readdir', 'mongodb', '', false],
    ['stat', 'mongodb', '', false],
  ],
  notion: [
    ['read', 'notion', '', false],
    ['readdir', 'notion', '', false],
    ['stat', 'notion', '', false],
  ],
  postgres: [
    ['read', 'postgres', '', false],
    ['readdir', 'postgres', '', false],
    ['stat', 'postgres', '', false],
  ],
  qdrant: [
    ['read', 'qdrant', '', false],
    ['readdir', 'qdrant', '', false],
    ['stat', 'qdrant', '', false],
  ],
  ram: [
    ['append', 'ram', '', true],
    ['create', 'ram', '', true],
    ['mkdir', 'ram', '', true],
    ['read', 'ram', '.feather', false],
    ['read', 'ram', '.h5', false],
    ['read', 'ram', '.parquet', false],
    ['read', 'ram', '', false],
    ['readdir', 'ram', '', false],
    ['rename', 'ram', '', true],
    ['rmdir', 'ram', '', true],
    ['setattr', 'ram', '', true],
    ['stat', 'ram', '', false],
    ['truncate', 'ram', '', true],
    ['unlink', 'ram', '', true],
    ['write', 'ram', '', true],
  ],
  slack: [
    ['read', 'slack', '', false],
    ['readdir', 'slack', '', false],
    ['stat', 'slack', '', false],
  ],
  trello: [
    ['read', 'trello', '', false],
    ['readdir', 'trello', '', false],
    ['stat', 'trello', '', false],
  ],
}

const sortRows = (rows: Row[]): Row[] =>
  [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))

for (const [backend, ops] of Object.entries(TABLES)) {
  test(`ops inventory: ${backend}`, () => {
    const actual = sortRows(ops.map((o) => [o.name, o.resource, o.filetype ?? '', o.write] as Row))
    const expected = OPS_INVENTORY[backend]
    if (!expected) throw new Error(`missing fixture: ${backend}`)
    expect(actual).toEqual(sortRows(expected))
  })
}

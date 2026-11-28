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
import type { DirListing } from '../../types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { readdir } from './readdir.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

const PREFIX = '/mnt/slack'

function p(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, PREFIX) })
}

// A day's row as its channel's listing names it.
function dayRow(channel: string, name = '2025-11-08'): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { channel_id: channel } })
}

// The day general holds three attachments.
const DAY = `${PREFIX}/channels/general__C1/2025-11-08`
const BLOBS = ['report__F2.pdf', 'notes__F3.txt', 'data__F4.bin']

describe('readdir: date directory layout', () => {
  it('readdir(<chan>/<date>) returns ["chat.jsonl", "files"] and seeds the files', async () => {
    const out = (await readdir(workspace.accessor(), p(DAY), dayRow('C1'))) as DirListing
    expect(rowsOf(out).map((row) => `${DAY}/${row.name}`)).toEqual([
      `${DAY}/chat.jsonl`,
      `${DAY}/files`,
    ])
    expect((out.seeds.get('files') ?? []).map((row) => row.name)).toEqual(BLOBS)
  })

  it('readdir(<chan>/<date>/files) is served from the day listing', async () => {
    const ws = new Workspace({
      [`${PREFIX}/`]: new SlackVFS({ accessor: workspace.accessor() }),
    })
    await ws.dispatch('readdir', DAY)
    await workspace.record()
    const out = await ws.dispatch('readdir', `${DAY}/files`)
    expect(out).toEqual(BLOBS.map((name) => `${DAY}/files/${name}`))
    expect(await workspace.run.requests()).toEqual([])
  })

  it('readdir(<chan>/<date>) is EACCES when conversations.history hits not_in_channel', async () => {
    await workspace.refuse(HISTORY, 'not_in_channel')
    await expect(
      readdir(workspace.accessor(), p(`${PREFIX}/channels/random__C2/2025-11-04`), dayRow('C2')),
    ).rejects.toMatchObject({ code: 'EACCES' })
  })
})

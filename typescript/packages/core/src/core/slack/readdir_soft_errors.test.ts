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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'

// Mirrors python/tests/core/slack/test_readdir_soft_errors.py: a Slack history
// refusal like `not_in_channel` / `missing_scope` is EACCES on the path, never
// an empty conversation. Slack refuses in a 200 body, the way every refusal
// comes.
const CHANNEL = '/slack/channels/random__C2'
const DAY = `${CHANNEL}/2025-11-04`

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

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/slack') })
}

function row(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { channel_id: 'C2' } })
}

function mounted(): Workspace {
  return new Workspace({ '/slack/': new SlackVFS({ accessor: workspace.accessor() }) })
}

describe('a channel Slack refuses', () => {
  it.each(['not_in_channel', 'channel_not_found', 'missing_scope', 'is_archived', 'not_authed'])(
    'is EACCES on %s',
    async (code) => {
      const ws = mounted()
      await ws.dispatch('readdir', '/slack/channels')
      await workspace.refuse(HISTORY, code)
      await expect(ws.dispatch('readdir', CHANNEL)).rejects.toMatchObject({
        code: 'EACCES',
        virtualPath: CHANNEL,
      })
    },
  )

  it('propagates any other Slack error', async () => {
    const ws = mounted()
    await ws.dispatch('readdir', '/slack/channels')
    await workspace.refuse(HISTORY, 'ratelimited')
    await expect(ws.dispatch('readdir', CHANNEL)).rejects.toThrow(/ratelimited/)
  })
})

describe('a day Slack refuses', () => {
  it.each(['', '/files'])('lists as EACCES at %s', async (below) => {
    await workspace.refuse(HISTORY, 'not_in_channel')
    const own = row(below === '' ? '2025-11-04' : 'files')
    await expect(readdir(workspace.accessor(), spec(DAY + below), own)).rejects.toMatchObject({
      code: 'EACCES',
      virtualPath: DAY + below,
    })
  })

  it('reads chat.jsonl as EACCES', async () => {
    await workspace.refuse(HISTORY, 'not_in_channel')
    const chat = `${DAY}/chat.jsonl`
    await expect(
      read(workspace.accessor(), spec(chat), null, row('2025-11-04')),
    ).rejects.toMatchObject({ code: 'EACCES', virtualPath: chat })
  })
})

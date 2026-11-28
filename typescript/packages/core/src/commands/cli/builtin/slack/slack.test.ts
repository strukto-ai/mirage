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
import { slackAccessor } from '../../../../accessor/slack.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import { SLACK } from './index.ts'
import { emojiList } from './emoji_list.ts'
import { listPins } from './list_pins.ts'
import { readMessages } from './read_messages.ts'
import { search } from './search.ts'
import { sendMessage } from './send_message.ts'
import { context } from '../../../../../tests/workspace/fixtures/context.ts'
import { serve } from '../../../../../tests/fixtures/kit_fake.ts'
import {
  HISTORY,
  POST,
  SEARCH_MESSAGES,
  SlackWorkspace,
} from '../../../../../tests/core/slack/workspace.ts'

function leafContext(leaf: string, flags: Record<string, string> = {}): Context {
  const spec = SLACK.spec.subcommands.find((s) => s.name === leaf)
  if (spec === undefined) throw new Error(`no slack leaf ${leaf}`)
  return context({ flags, spec })
}

const DEC = new TextDecoder()
// "lunch at noon" in general.
const LUNCH = '1762214460.000001'

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

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

const VERBS = [
  'send-message',
  'edit-message',
  'delete-message',
  'upload-file',
  'read-messages',
  'react',
  'reactions',
  'pin-message',
  'unpin-message',
  'list-pins',
  'member-info',
  'list-members',
  'emoji-list',
  'search',
]

describe('slack tree', () => {
  it('matches the OpenClaw vocabulary and registers itself', () => {
    expect(SLACK.spec.subcommands.map((v) => v.name)).toEqual(VERBS)
    expect(cliSpecFor('slack')).toBe(SLACK)
    expect(SLACK.accessor).toBe(slackAccessor)
  })

  it('classifies writers', () => {
    const writers = new Set(
      SLACK.spec.subcommands.filter((v) => SLACK.handlers[v.name]?.write).map((v) => v.name),
    )
    expect(writers).toEqual(
      new Set([
        'send-message',
        'edit-message',
        'delete-message',
        'upload-file',
        'react',
        'pin-message',
        'unpin-message',
      ]),
    )
  })
})

describe('slack verbs', () => {
  it('send-message posts, and threads when --thread-ts is given', async () => {
    const accessor = workspace.accessor()
    await sendMessage(accessor, [], [], leafContext('send-message', { channel: 'C1', text: 'hi' }))
    await sendMessage(
      accessor,
      [],
      [],
      leafContext('send-message', { channel: 'C1', text: 'hi', thread_ts: LUNCH }),
    )
    expect(await workspace.run.bodies('POST', POST)).toEqual([
      { channel: 'C1', text: 'hi' },
      { channel: 'C1', thread_ts: LUNCH, text: 'hi' },
    ])
    const [reply, post] = await workspace.history('C1')
    expect([post?.text, post?.thread_ts]).toEqual(['hi', undefined])
    expect([reply?.text, reply?.thread_ts]).toEqual(['hi', LUNCH])
  })

  it('read-messages defaults the limit to 20', async () => {
    const [out] = unwrap(
      await readMessages(
        workspace.accessor(),
        [],
        [],
        leafContext('read-messages', { channel: 'C1' }),
      ),
    )
    expect(await workspace.run.params('GET', HISTORY)).toEqual([{ channel: 'C1', limit: '20' }])
    const texts = (JSON.parse(DEC.decode(out as Uint8Array)) as { text: string }[]).map(
      (m) => m.text,
    )
    expect(texts.slice(0, 2)).toEqual(['the deploy is done at acme', 'coffee is ready'])
  })

  it('read-messages and search keep an explicit zero', async () => {
    const accessor = workspace.accessor()
    await readMessages(accessor, [], [], context({ flags: { channel: 'C1', limit: 0 } }))
    await search(accessor, [], [], context({ flags: { query: 'q', count: 0, page: 0 } }))
    expect(await workspace.run.params('GET', HISTORY)).toEqual([{ channel: 'C1', limit: '0' }])
    expect((await workspace.run.params('GET', SEARCH_MESSAGES))[0]).toMatchObject({
      query: 'q',
      count: '0',
      page: '0',
    })
  })

  it('list-pins renders the items array', async () => {
    await workspace.pin('C1', LUNCH)
    const [out] = unwrap(
      await listPins(workspace.accessor(), [], [], leafContext('list-pins', { channel: 'C1' })),
    )
    const items = JSON.parse(DEC.decode(out as Uint8Array)) as {
      type: string
      message: { ts: string }
    }[]
    expect(items.map((i) => [i.type, i.message.ts])).toEqual([['message', LUNCH]])
  })

  it('emoji-list renders the emoji mapping', async () => {
    const [out] = unwrap(await emojiList(workspace.accessor(), [], [], leafContext('emoji-list')))
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({
      shipit: 'https://emoji.example/shipit.png',
      partyparrot: 'alias:parrot',
    })
  })
})

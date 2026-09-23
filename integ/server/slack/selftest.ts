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

// What the battery cannot see, because mirage never asks for it: the calls
// slack-mcp-server makes before and around its tools. auth.test is its first
// call and names the URL every later one goes to, client.userBoot must answer
// before it starts, channels_list prints each channel's topic, purpose and
// member count, conversations_replies reads a thread, and slack-go sends every
// argument as a form body.

import { isDeepStrictEqual } from 'node:util'

import { start } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { slackFake } from './fake.ts'

type Json = Record<string, JsonValue>

const TENANT = 'selftest-slack'
const THREAD = '1762352718.000015'
const REPLY = '1762352873.000016'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`slack selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue | undefined, want: JsonValue): void {
  const same = isDeepStrictEqual(got, want)
  check(name, same, same ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

function decoded(cursor: JsonValue | undefined): string {
  return Buffer.from(String(cursor), 'base64').toString('utf8')
}

async function main(): Promise<void> {
  const fake = await start(slackFake, 0)
  const call = async (
    method: string,
    form: Record<string, string> = {},
    at = '',
  ): Promise<Json> => {
    const response = await fetch(`${fake.endpoint}${at}/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer xoxb-${TENANT}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    })
    return (await response.json()) as Json
  }
  try {
    await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })

    const auth = await call('auth.test')
    eq('auth.test names the fake as the workspace', auth.url, `${fake.endpoint}/`)
    eq('auth.test names the token holder', [auth.user_id!, auth.team_id!], ['UBOT', 'T1'])
    eq(
      'auth.test keeps the run a client comes back to',
      (await call('auth.test', {}, '/_run/r1')).url,
      `${fake.endpoint}/_run/r1/`,
    )
    const boot = await call('client.userBoot')
    eq('client.userBoot answers', boot.ok, true)
    eq('client.userBoot lists DMs, none shared', (boot.ims as Json[]).length, 10)

    const types = 'public_channel,private_channel'
    const first = await call('conversations.list', { types, limit: '1' })
    const channels = first.channels as Json[]
    eq('conversations.list honours limit', channels.length, 1)
    eq(
      'a channel carries topic, purpose and its member count',
      [
        channels[0]!.name_normalized!,
        (channels[0]!.topic as Json).value!,
        String((channels[0]!.purpose as Json).value).slice(0, 19),
        channels[0]!.num_members!,
      ],
      ['general', '', 'Share announcements', 16],
    )
    const cursor = (first.response_metadata as Json).next_cursor
    eq('the cursor names the next conversation', decoded(cursor), 'team:C10')
    const seen: string[] = [String(channels[0]!.id)]
    let next = String(cursor)
    while (next !== '') {
      const page = await call('conversations.list', { types, limit: '3', cursor: next })
      for (const one of page.channels as Json[]) seen.push(String(one.id))
      next = String((page.response_metadata as Json).next_cursor)
    }
    eq('following the cursor lists every channel once', seen, [
      'C1',
      'C10',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
    ])
    eq(
      'an unknown cursor is refused',
      (await call('conversations.list', { cursor: 'bm9wZQ==' })).error,
      'invalid_cursor',
    )

    const thread = await call('conversations.replies', { channel: 'C4', ts: THREAD })
    const messages = thread.messages as Json[]
    eq(
      'a thread is its parent then its replies',
      messages.map((m) => m.ts!),
      [THREAD, REPLY],
    )
    eq(
      'the parent counts its replies',
      [messages[0]!.thread_ts!, messages[0]!.reply_count!, messages[0]!.reply_users!],
      [THREAD, 1, ['U17']],
    )
    eq(
      'a reply names its thread and its parent author',
      [messages[1]!.thread_ts!, messages[1]!.parent_user_id!],
      [THREAD, 'U3'],
    )
    eq(
      'a reply ts reaches the same thread',
      ((await call('conversations.replies', { channel: 'C4', ts: REPLY })).messages as Json[]).map(
        (m) => m.ts!,
      ),
      [THREAD, REPLY],
    )
    const paged = await call('conversations.replies', { channel: 'C4', ts: THREAD, limit: '1' })
    eq('a thread pages', [(paged.messages as Json[]).length, paged.has_more!], [1, true])
    eq(
      'the thread cursor names the next reply',
      decoded((paged.response_metadata as Json).next_cursor),
      `next_ts:${REPLY.replace('.', '')}`,
    )
    const after = (
      await call('conversations.replies', { channel: 'C4', ts: THREAD, oldest: THREAD })
    ).messages as Json[]
    eq(
      'oldest bounds a thread, exclusive by default',
      after.map((m) => m.ts!),
      [REPLY],
    )
    eq(
      'a reply bounded away from its parent still names its author',
      after[0]!.parent_user_id!,
      'U3',
    )
    const before = (
      await call('conversations.replies', { channel: 'C4', ts: THREAD, latest: REPLY })
    ).messages as Json[]
    eq(
      'a parent bounded away from its replies still counts them',
      [before.length, before[0]!.reply_count!, before[0]!.latest_reply!],
      [1, 1, REPLY],
    )
    eq(
      'an unknown thread is refused',
      (await call('conversations.replies', { channel: 'C4', ts: '1.000000' })).error,
      'thread_not_found',
    )
    eq(
      'an unknown channel is refused',
      (await call('conversations.replies', { channel: 'C99', ts: THREAD })).error,
      'channel_not_found',
    )
    eq(
      'history reads its arguments from a form body',
      ((await call('conversations.history', { channel: 'C4', limit: '1' })).messages as Json[])
        .length,
      1,
    )
    process.stdout.write(`slack selftest: ${String(checks)} checks passed\n`)
  } finally {
    await fake.close()
  }
}

await main()

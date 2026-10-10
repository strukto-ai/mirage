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
    const listed = async (selected: string): Promise<string[]> =>
      ((await call('conversations.list', { types: selected })).channels as Json[]).map((c) =>
        String(c.id),
      )
    eq('public-only conversation list excludes private channels', await listed('public_channel'), [
      'C1',
      'C10',
      'C2',
      'C3',
      'C4',
      'C6',
      'C7',
      'C8',
      'C9',
    ])
    eq('private-only conversation list excludes public channels', await listed('private_channel'), [
      'C5',
    ])
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

    const historyPage = await call('conversations.history', { channel: 'C4', limit: '1' })
    const nextHistory = await call('conversations.history', {
      channel: 'C4',
      limit: '1',
      cursor: String((historyPage.response_metadata as Json).next_cursor),
    })
    check(
      'history follows its cursor',
      historyPage.has_more === true &&
        (historyPage.messages as Json[])[0]!.ts !== (nextHistory.messages as Json[])[0]!.ts,
    )
    const wholeHistory = (await call('conversations.history', { channel: 'C4' })).messages as Json[]
    const pagedHistory: JsonValue[] = []
    let historyCursor = ''
    do {
      const page = await call('conversations.history', {
        channel: 'C4',
        limit: '2',
        ...(historyCursor === '' ? {} : { cursor: historyCursor }),
      })
      for (const one of page.messages as Json[]) pagedHistory.push(one.ts!)
      historyCursor = String((page.response_metadata as Json).next_cursor)
    } while (historyCursor !== '')
    eq(
      'following the history cursor lists every message once',
      pagedHistory,
      wholeHistory.map((m) => m.ts!),
    )
    eq(
      'an unknown history cursor is refused',
      (
        await call('conversations.history', {
          channel: 'C4',
          cursor: Buffer.from('next_ts:1000000000000001', 'utf8').toString('base64'),
        })
      ).error,
      'invalid_cursor',
    )
    const microseconds = await call('conversations.history', {
      channel: 'C4',
      oldest: THREAD.replace('.000015', '.15'),
      latest: THREAD,
      inclusive: 'true',
    })
    eq(
      'history timestamps use a microsecond suffix',
      (microseconds.messages as Json[]).map((m) => m.ts!),
      [THREAD],
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

    for (const [query, total] of [
      ['deploying from:@marcus', 2],
      ['deploying from:<@U8>', 2],
      ['deploying in:#engineering', 4],
      ['deploying in:engineering', 4],
      ['deploying in:engineering from:<@U8>', 2],
      ['deploying in:absent', 0],
      ['"in:engineering"', 0],
      ['deploying in:##engineering', 4],
      ['deploying in:##engineering from:<@U8>', 2],
      ['has::rocket:', 13],
      ['in:#engineering has::rocket:', 2],
      ['deploying in:#engineering has::rocket:', 0],
      ['"has::rocket:"', 0],
    ] as const) {
      const response = await fetch(`${fake.endpoint}/api/search.messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer xoxp-${TENANT}` },
        body: new URLSearchParams({ query }),
      })
      const reply = (await response.json()) as Json
      eq(query, (reply.messages as Json).total, total)
    }

    await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'search' }),
    })
    const search = async (
      method: string,
      token: string,
      transport: string,
      params: Record<string, string> = {},
    ): Promise<Json> => {
      const form = new URLSearchParams({ query: 'searchable during:2025-11-03', ...params })
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
      if (transport === 'header') headers.Authorization = `Bearer ${token}-${TENANT}`
      else form.set('token', `${token}-${TENANT}`)
      const response = await fetch(
        `${fake.endpoint}/api/${method}${transport === 'query' ? '?' + form.toString() : ''}`,
        {
          method: transport === 'query' ? 'GET' : 'POST',
          headers,
          ...(transport === 'query' ? {} : { body: form.toString() }),
        },
      )
      eq('search uses the Slack HTTP success envelope', response.status, 200)
      return (await response.json()) as Json
    }
    for (const token of ['xoxp', 'xoxc']) {
      for (const transport of ['header', 'form', 'query']) {
        const all = await search('search.all', token, transport)
        const messages = (await search('search.messages', token, transport)).messages as Json
        const files = (await search('search.files', token, transport)).files as Json
        eq('search.all shares message format with search.messages', all.messages ?? null, messages)
        eq('search.all shares file format with search.files', all.files, files)
        eq('search omits joins/leaves and keeps conversation activity', messages.total, 3)
        eq(
          'search preserves subtype',
          (messages.matches as Json[])[0]!.subtype,
          'channel_convert_to_private',
        )
        eq('search.files has its own total', files.total, 1)
      }
    }
    eq(
      'bot search remains refused',
      (await search('search.all', 'xoxb', 'form')).error,
      'not_allowed_token_type',
    )
    eq(
      'during and on match the same day',
      (await search('search.messages', 'xoxc', 'form')).messages ?? null,
      (await search('search.messages', 'xoxc', 'form', { query: 'searchable on:2025-11-03' }))
        .messages ?? null,
    )
    const second = (await search('search.messages', 'xoxc', 'form', { count: '1', page: '2' }))
      .messages as Json
    eq('pagination totals are not truncated to count', second.total, 3)
    eq(
      'pagination selects a distinct second result',
      (second.matches as Json[]).map((m) => m.ts!),
      ['1762186003.000001'],
    )
    eq('paging matches the Slack wire format', second.paging, {
      count: 1,
      total: 3,
      page: 2,
      pages: 3,
    })
    eq(
      'unknown channels do not broaden search',
      ((await search('search.messages', 'xoxc', 'form', { query: 'in:#absent' })).messages as Json)
        .total,
      0,
    )
    for (const method of ['search.messages', 'search.all']) {
      for (const query of [
        'from:@ana',
        'from:ana',
        'from:<@U1>',
        'in:#general',
        'in:##general',
        'in:##general from:<@U1>',
      ]) {
        const result = await search(method, 'xoxp', 'form', { query })
        eq(`${method} scopes ${query}`, (result.messages as Json).total, 3)
      }
      for (const query of ['from:<@U404>', 'in:##absent', '"from:<@U1>"', '"in:##general"']) {
        const result = await search(method, 'xoxp', 'form', { query })
        eq(`${method} does not broaden ${query}`, (result.messages as Json).total, 0)
      }
    }
    eq(
      'file search cannot ignore an ID author filter',
      ((await search('search.files', 'xoxp', 'form', { query: 'from:<@U1>' })).files as Json).total,
      0,
    )
    eq(
      'file search accepts doubled channel markers',
      (
        (await search('search.files', 'xoxp', 'form', { query: 'in:##general searchable' }))
          .files as Json
      ).total,
      1,
    )
    const rendered = (await search('search.messages', 'xoxp', 'form')).messages as Json
    eq(
      'search renders emphasis and named mentions while preserving underscores in words',
      (rendered.matches as Json[])[2]!.text,
      'searchable message from <@U1|Ana>; snake_case and _unclosed',
    )
    const history = (await call('conversations.history', { channel: 'C1' })).messages as Json[]
    eq(
      'history keeps stored emphasis and bare mentions',
      history[1]!.text,
      'searchable _message_ from <@U1>; snake_case and _unclosed',
    )
    eq(
      'history preserves joins and leaves as activity',
      history.filter((m) => m.subtype).map((m) => m.subtype!),
      ['channel_convert_to_private', 'channel_leave', 'channel_join'],
    )
    const replies = (
      await call('conversations.replies', { channel: 'C1', ts: '1762186002.000001' })
    ).messages as Json[]
    eq('replies preserve the parent subtype', replies[0]!.subtype, 'channel_convert_to_private')
    process.stdout.write(`slack selftest: ${String(checks)} checks passed\n`)
  } finally {
    await fake.close()
  }
}

await main()

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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import { DiscordAccessor } from '../../accessor/discord.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './client.ts'
import { snowflakeAt } from './history.ts'
import { follow, read, readMany, readStream } from './read.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(
    private readonly responder: (method: DiscordMethod, endpoint: string) => DiscordResponse = () =>
      null,
  ) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(method, endpoint))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const decoder = new TextDecoder()

const CHAT = '/mnt/discord/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl'
const MEMBER = '/mnt/discord/My Server__G1/members/alice__U1.json'

// The rows the listings name: chat.jsonl and its day carry their channel.
const chatRow = new FileStat({
  name: 'chat.jsonl',
  type: FileType.FILE,
  extra: { channel_id: 'C1' },
})
const dayRow = new FileStat({
  name: '2024-01-15',
  type: FileType.DIRECTORY,
  extra: { channel_id: 'C1' },
})
const aliceRow = new FileStat({
  name: 'alice__U1.json',
  type: FileType.FILE,
  extra: { user_id: 'U1' },
})

describe('read history jsonl branch', () => {
  it('reads channel jsonl bytes for the channel its row names', async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        return [
          { id: '1196300000000000000', content: 'hello' },
          { id: '1196400000000000000', content: 'world' },
        ]
      }
      return null
    })
    const out = await read(new DiscordAccessor(t), spec(CHAT, '/mnt/discord'), chatRow, dayRow)
    const text = decoder.decode(out).trimEnd()
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] ?? '') as { content: string }
    expect(first.content).toBe('hello')
    const histCall = t.calls.find((c) => c.endpoint === '/channels/C1/messages')
    expect(histCall).toBeDefined()
  })

  it('throws ENOENT for jsonl path when no row names its channel', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(read(new DiscordAccessor(t), spec(CHAT, '/mnt/discord'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('read members branch', () => {
  it('returns JSON-stringified member bytes for matching user id', async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [
          { user: { id: 'U2', username: 'bob' }, nick: 'Bob' },
          { user: { id: 'U1', username: 'alice' }, nick: 'Alice' },
        ]
      }
      return null
    })
    const out = await read(new DiscordAccessor(t), spec(MEMBER, '/mnt/discord'), aliceRow)
    const parsed = JSON.parse(decoder.decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({
      user: { id: 'U1', username: 'alice' },
      nick: 'Alice',
    })
    const memCall = t.calls.find((c) => c.endpoint === '/guilds/G1/members')
    expect(memCall).toBeDefined()
  })

  it('throws ENOENT for members path when no row is handed', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(read(new DiscordAccessor(t), spec(MEMBER, '/mnt/discord'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT when no member matches the handed user id', async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [{ user: { id: 'U2', username: 'bob' } }]
      }
      return null
    })
    await expect(
      read(new DiscordAccessor(t), spec(MEMBER, '/mnt/discord'), aliceRow),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1/foo/bar', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR for root', async () => {
    // The root exists by construction, so reading it as a file is the one
    // shape the kit reports as a directory rather than absent.
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(new DiscordAccessor(t), spec('/mnt/discord', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

it('closes an attachment stream before fetching its tail', async () => {
  let closed = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('first\n'))
      },
      cancel() {
        closed = true
      },
    },
    { highWaterMark: 0 },
  )
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
  const path = spec('/Guild__G1/channels/general__C1/2026-04-24/files/report__F1.txt')
  const row = new FileStat({
    name: 'report__F1.txt',
    type: FileType.FILE,
    extra: { attachment_id: 'F1', url: 'https://cdn.test/report' },
  })
  try {
    const stream = readStream(new DiscordAccessor(new FakeDiscordTransport()), path, row)
    const first = await stream.next()
    if (first.done) throw new Error('attachment stream ended before its first chunk')
    expect(new TextDecoder().decode(first.value)).toBe('first\n')
    await stream.return()
    expect(closed).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})

describe('follow', () => {
  it('prints the last lines, then asks after the last one seen', async () => {
    const day = [
      { id: '1196400000000000000', content: 'world' },
      { id: '1196300000000000000', content: 'hello' },
    ]
    const later = { id: '1196450000000000000', content: 'later' }
    const t: FakeDiscordTransport = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint !== '/channels/C1/messages') return null
      // `later` lands once the day has been read, so only a poll sees it.
      const after = BigInt(t.calls[t.calls.length - 1]?.params?.after ?? 0)
      const posted = after >= BigInt(day[0]?.id ?? 0) ? [later] : day
      return posted.filter((m) => BigInt(m.id) > after) as DiscordResponse
    })
    const stream = await follow(
      new DiscordAccessor(t),
      spec(CHAT, '/mnt/discord'),
      1,
      0.001,
      chatRow,
      dayRow,
    )
    if (stream === null) throw new Error('the chat day was not followed')
    const it = stream[Symbol.asyncIterator]()
    const contents = async (): Promise<string[]> =>
      decoder
        .decode(((await it.next()).value as Uint8Array | undefined) ?? new Uint8Array())
        .trimEnd()
        .split('\n')
        .map((line) => (JSON.parse(line) as { content: string }).content)
    expect(await contents()).toEqual(['world'])
    expect(await contents()).toEqual(['later'])
    const idle = it.next()
    await it.return?.()
    expect((await idle).done).toBe(true)
    const asked = t.calls.filter((c) => c.endpoint === '/channels/C1/messages')
    expect(asked.map((c) => c.params?.after)).toContain('1196400000000000000')
  })
})

// Twin of test_a_batch_walks_a_run_of_days_once.
it('walks a run of days of a batch once', async () => {
  const idx = new RAMIndexCacheStore()
  const channels = '/mnt/discord/My Server__G1/channels'
  await idx.setDir(channels, [
    [
      'general__C1',
      new IndexEntry({
        id: 'C1',
        name: 'general',
        resourceType: 'discord/channel',
        vfsName: 'general__C1',
      }),
    ],
  ])
  const days = ['2024-01-15', '2024-01-16']
  for (const day of days) {
    await idx.setDir(`${channels}/general__C1/${day}`, [
      [
        'chat.jsonl',
        new IndexEntry({
          id: `C1:${day}:chat`,
          name: 'chat.jsonl',
          resourceType: 'discord/chat_jsonl',
          vfsName: 'chat.jsonl',
        }),
      ],
    ])
  }
  const [onDay, later] = [
    [Date.UTC(2024, 0, 15, 10), 'a'],
    [Date.UTC(2024, 0, 16, 1), 'b'],
  ].map(([at, text]) => ({ id: snowflakeAt(Number(at) / 1000).toString(), content: text }))
  const t = new FakeDiscordTransport(() => [onDay, later])
  const chats = days.map((day) => `${channels}/general__C1/${day}/chat.jsonl`)
  const answers = await readMany(
    new DiscordAccessor(t),
    chats.map((v) => spec(v, '/mnt/discord')),
    1 << 20,
    idx,
  )
  const lines = (body: Uint8Array | undefined): unknown[] =>
    decoder
      .decode(body)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as unknown)
  expect(chats.map((chat) => lines(answers.get(chat)))).toEqual([[onDay], [later]])
  expect(t.calls.filter((call) => call.endpoint === '/channels/C1/messages')).toHaveLength(1)
})

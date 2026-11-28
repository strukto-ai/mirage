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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import { LISTING_TRUST_WINDOW } from '../../cache/index/constants.ts'
import { commandScope } from '../../cache/index/scope.ts'
import { FileStat, FileType, PathSpec, ReadPolicy } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  ALICE,
  DAY as DATE,
  DiscordGuild,
  GENERAL,
  MEMBERS,
  MESSAGES,
} from '../../../tests/core/discord/guild.ts'
import { jsonlBytes } from '../render/json.ts'
import { follow, read, readMany, readStream } from './read.ts'
import { readdir } from './readdir.ts'

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const decoder = new TextDecoder()
const CHANNEL = '/mnt/discord/My Server__111/channels/general__211'
const CHAT = `${CHANNEL}/${DATE}/chat.jsonl`
const MEMBER = '/mnt/discord/My Server__111/members/alice__311.json'

// The rows the listings name: chat.jsonl and its day carry their channel.
const chatRow = new FileStat({
  name: 'chat.jsonl',
  type: FileType.FILE,
  extra: { channel_id: GENERAL },
})

function dayRowOf(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { channel_id: GENERAL } })
}

const dayRow = dayRowOf(DATE)

const aliceRow = new FileStat({
  name: 'alice__311.json',
  type: FileType.FILE,
  extra: { user_id: ALICE },
})

function contents(body: Uint8Array | undefined): string[] {
  return decoder
    .decode(body)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { content: string }).content)
}

describe('read history jsonl branch', () => {
  it('reads channel jsonl bytes for the channel its row names', async () => {
    const out = await read(guild.accessor(), spec(CHAT, '/mnt/discord'), chatRow, dayRow)
    expect(contents(out)).toEqual(['hello', 'files'])
    expect(await guild.dayFetches()).toEqual([[GENERAL, DATE]])
  })

  it('throws ENOENT for jsonl path when no row names its channel', async () => {
    await expect(read(guild.accessor(), spec(CHAT, '/mnt/discord'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

const OTHER_DAY = `${CHANNEL}/2024-01-14`

function listDay(accessor: DiscordAccessor, day = `${CHANNEL}/${DATE}`, row = dayRow) {
  return readdir(accessor, spec(day, '/mnt/discord'), row)
}

function readChat(accessor: DiscordAccessor): Promise<Uint8Array> {
  return read(accessor, spec(CHAT, '/mnt/discord'), chatRow, dayRow)
}

describe('a read after its day listing', () => {
  // Twin of test_a_read_takes_the_day_its_listing_fetched.
  it('takes the messages the listing fetched', async () => {
    const accessor = guild.accessor()
    await commandScope(async () => {
      await listDay(accessor)
      expect(decoder.decode(await readChat(accessor))).toContain('hello')
    })
    expect(await guild.dayFetches()).toHaveLength(1)
  })

  // Twin of test_only_the_last_listed_day_is_kept_for_one_read.
  it('keeps only the last listed day, for one read', async () => {
    const accessor = guild.accessor()
    await commandScope(async () => {
      await listDay(accessor)
      await readChat(accessor)
      await readChat(accessor)
      await listDay(accessor, OTHER_DAY, dayRowOf('2024-01-14'))
      await readChat(accessor)
    })
    expect(await guild.dayFetches()).toEqual([
      [GENERAL, DATE],
      [GENERAL, DATE],
      [GENERAL, '2024-01-14'],
      [GENERAL, DATE],
    ])
  })

  // Twin of test_a_dropped_or_expired_day_is_fetched_again.
  it.each(['forget', 'fresh', 'late'])('fetches the day again after %s', async (drop) => {
    const accessor = guild.accessor()
    if (drop === 'fresh') accessor.govern?.({ policy: ReadPolicy.FRESH, ttl: 600 })
    const realNow = Date.now.bind(Date)
    try {
      await commandScope(async () => {
        await listDay(accessor)
        if (drop === 'forget') accessor.forget?.()
        if (drop === 'late') {
          vi.spyOn(Date, 'now').mockImplementation(() => realNow() + LISTING_TRUST_WINDOW * 1000)
        }
        await readChat(accessor)
      })
    } finally {
      vi.restoreAllMocks()
    }
    expect(await guild.dayFetches()).toHaveLength(2)
  })

  // Twin of test_only_the_listing_command_takes_the_day.
  const scopes: [string, (fn: () => Promise<unknown>) => Promise<unknown>][] = [
    ['the next command', commandScope],
    ['no command', (fn) => fn()],
  ]

  it.each(scopes)('fetches the day again for a read in %s', async (_name, scope) => {
    const accessor = guild.accessor()
    await scope(() => listDay(accessor))
    await scope(() => readChat(accessor))
    expect(await guild.dayFetches()).toHaveLength(2)
  })
})

describe('read members branch', () => {
  it('returns JSON-stringified member bytes for matching user id', async () => {
    const out = await read(guild.accessor(), spec(MEMBER, '/mnt/discord'), aliceRow)
    const parsed = JSON.parse(decoder.decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({ user: { id: ALICE, username: 'alice' }, nick: 'al' })
    expect(await guild.count(MEMBERS)).toBe(1)
  })

  it('throws ENOENT for members path when no row is handed', async () => {
    await expect(read(guild.accessor(), spec(MEMBER, '/mnt/discord'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT when no member matches the handed user id', async () => {
    const stranger = new FileStat({
      name: 'carol__399.json',
      type: FileType.FILE,
      extra: { user_id: '399' },
    })
    await expect(
      read(
        guild.accessor(),
        spec('/mnt/discord/My Server__111/members/carol__399.json', '/mnt/discord'),
        stranger,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    await expect(
      read(guild.accessor(), spec('/mnt/discord/My Server__111/foo/bar', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR for root', async () => {
    // The root exists by construction, so reading it as a file is the one
    // shape the kit reports as a directory rather than absent.
    await expect(
      read(guild.accessor(), spec('/mnt/discord', '/mnt/discord')),
    ).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })
})

it('closes an attachment stream before fetching its tail', async () => {
  // The download is staged: over the wire, a read closed after its first
  // chunk cannot be told from one that fetched the rest.
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
    const stream = readStream(guild.accessor(), path, row)
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
    const day = await guild.day(GENERAL, DATE)
    const stream = await follow(
      guild.accessor(),
      spec(CHAT, '/mnt/discord'),
      1,
      0.001,
      chatRow,
      dayRow,
    )
    if (stream === null) throw new Error('the chat day was not followed')
    const it = stream[Symbol.asyncIterator]()
    const next = async (): Promise<string[]> =>
      contents(((await it.next()).value as Uint8Array | undefined) ?? new Uint8Array())
    expect(await next()).toEqual(['files'])
    // Another client posts on the day; storing it reloads the run, so the
    // recording restarts after.
    await guild.addMessage(GENERAL, new Date(Date.UTC(2024, 0, 15, 12)), ALICE, 'later')
    expect(await next()).toEqual(['later'])
    const idle = it.next()
    await it.return?.()
    expect((await idle).done).toBe(true)
    const asked = await guild.run.params('GET', MESSAGES)
    expect(asked.map((p) => p.after)).toContain(day.at(-1)?.id)
  })
})

// Twin of test_a_batch_walks_a_run_of_days_once: 2024-01-15 and 01-16 are one
// run of days, walked by one listing.
it('walks a run of days of a batch once', async () => {
  const days = [DATE, '2024-01-16']
  const chat = new FileStat({
    name: 'chat.jsonl',
    type: FileType.FILE,
    extra: { channel_id: GENERAL },
  })
  const chats = days.map((day) => `${CHANNEL}/${day}/chat.jsonl`)
  const answers = await readMany(
    guild.accessor(),
    chats.map((v) => spec(v, '/mnt/discord')),
    1 << 20,
    chats.map(() => ({ entry: chat })),
  )
  const expected = await Promise.all(
    days.map(async (day) => jsonlBytes(await guild.day(GENERAL, day))),
  )
  expect(chats.map((c) => decoder.decode(answers.get(c)))).toEqual(
    expected.map((bytes) => decoder.decode(bytes)),
  )
  expect(await guild.dayFetches()).toEqual([[GENERAL, DATE]])
})

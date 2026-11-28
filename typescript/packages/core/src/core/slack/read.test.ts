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
import { SlackAccessor } from '../../accessor/slack.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, SlackWorkspace, USER as INFO } from '../../../tests/core/slack/workspace.ts'
import { follow, read, readMany, readStream } from './read.ts'

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

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const decoder = new TextDecoder()
// general's first day ends with ben's coffee.
const COFFEE = '1762131600.000001'

function texts(bytes: Uint8Array | undefined): string[] {
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { text: string }).text)
}

// A day's row as its conversation's listing names it, carrying the channel.
function dayRow(channel: string, name = '2025-11-03'): FileStat {
  return new FileStat({
    name,
    type: FileType.DIRECTORY,
    extra: { channel_id: channel },
  })
}

// A user's row as the users listing names it.
const USER = new FileStat({ name: 'ana__U1.json', type: FileType.FILE, extra: { user_id: 'U1' } })

// An attachment's row as its day's files listing names it.
const BLOB = new FileStat({
  name: 'report__F1.txt',
  type: FileType.FILE,
  extra: { file_id: 'F1', url_private_download: 'https://cdn.test/report' },
})

describe('read jsonl branch', () => {
  it('reads channel jsonl bytes through the channel its day carries', async () => {
    const out = await read(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1/2025-11-03/chat.jsonl', '/mnt/slack'),
      null,
      dayRow('C1'),
    )
    expect(texts(out)).toEqual(['the deploy is done at acme', 'coffee is ready'])
    expect((await workspace.run.params('GET', HISTORY))[0]?.channel).toBe('C1')
  })

  it('reads dm jsonl bytes through the dm its day carries', async () => {
    const out = await read(
      workspace.accessor(),
      spec('/mnt/slack/dms/ana__D1/2025-11-03/chat.jsonl', '/mnt/slack'),
      null,
      dayRow('D1'),
    )
    expect(texts(out)).toEqual(['deploy in a dm'])
    expect((await workspace.run.params('GET', HISTORY))[0]?.channel).toBe('D1')
  })

  it('throws ENOENT for a chat.jsonl no listing names', async () => {
    await expect(
      read(
        workspace.accessor(),
        spec('/mnt/slack/channels/general__C1/2025-11-03/chat.jsonl', '/mnt/slack'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read users branch', () => {
  it('returns JSON-stringified user profile bytes', async () => {
    const out = await read(
      workspace.accessor(),
      spec('/mnt/slack/users/ana__U1.json', '/mnt/slack'),
      USER,
    )
    const parsed = JSON.parse(decoder.decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({ id: 'U1', name: 'ana', real_name: 'Ana Lima' })
    expect(await workspace.run.params('GET', INFO)).toEqual([{ user: 'U1' }])
  })

  it('throws ENOENT for a user no listing names', async () => {
    await expect(
      read(workspace.accessor(), spec('/mnt/slack/users/ana__U1.json', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    await expect(
      read(workspace.accessor(), spec('/mnt/slack/foo/bar', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR for root', async () => {
    // The root exists by construction, so reading it as a file is the one
    // shape the kit reports as a directory rather than absent.
    await expect(
      read(workspace.accessor(), spec('/mnt/slack', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

it('closes an attachment stream before fetching its tail', async () => {
  // The download is staged: over the wire, a read closed after its first
  // chunk cannot be told from one that fetched the rest.
  let closed = false
  async function* source() {
    try {
      yield await Promise.resolve(new TextEncoder().encode('first\n'))
      throw new Error('fetched tail')
    } finally {
      closed = true
    }
  }
  const path = spec('/channels/general__C1/2026-04-24/files/report__F1.txt')
  try {
    const stream = readStream(
      new SlackAccessor({ call: () => Promise.resolve({ ok: true }), downloadFileStream: source }),
      path,
      BLOB,
    )
    const first = await stream.next()
    if (first.done) throw new Error('attachment stream ended before its first chunk')
    expect(new TextDecoder().decode(first.value)).toBe('first\n')
    await stream.return()
    expect(closed).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('uses bounded buffered downloads when a custom transport has no stream method', async () => {
  // A transport of its own: the HTTP one always streams.
  const path = spec('/channels/general__C1/2026-04-24/files/report__F1.txt')
  const bytes = new Uint8Array(40_000).fill(65)
  const downloadFile = vi.fn().mockResolvedValue(bytes)
  const received: Uint8Array[] = []
  for await (const chunk of readStream(
    new SlackAccessor({ call: () => Promise.resolve({ ok: true }), downloadFile }),
    path,
    BLOB,
  ))
    received.push(chunk)
  expect(received.map((chunk) => chunk.byteLength)).toEqual([16384, 16384, 7232])
  expect(received.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(bytes.byteLength)
  expect(downloadFile).toHaveBeenCalledWith('https://cdn.test/report', 0, null)
})

describe('follow', () => {
  it('prints the last lines, then asks after the last one seen', async () => {
    const stream = await follow(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1/2025-11-03/chat.jsonl', '/mnt/slack'),
      1,
      0.001,
      null,
      dayRow('C1'),
    )
    if (stream === null) throw new Error('the chat day was not followed')
    const it = stream[Symbol.asyncIterator]()
    const next = async (): Promise<string[]> =>
      texts(((await it.next()).value as Uint8Array | undefined) ?? new Uint8Array())
    expect(await next()).toEqual(['coffee is ready'])
    // Another client posts on the day; executing it reloads the run, so the
    // recording restarts after.
    await workspace.run.execute(
      'INSERT INTO Message (tenant, channelId, ts, userId, text, seq) ' +
        "VALUES ('unit', 'C1', '1762135200.000001', 'U2', 'tea too', 99)",
    )
    await workspace.record()
    expect(await next()).toEqual(['tea too'])
    const idle = it.next()
    await it.return?.()
    expect((await idle).done).toBe(true)
    expect((await workspace.run.params('GET', HISTORY))[0]?.oldest).toBe(COFFEE)
  })

  it('follows only a chat day', async () => {
    expect(
      await follow(workspace.accessor(), spec('/mnt/slack/users/ana__U1.json', '/mnt/slack'), 1, 1),
    ).toBeNull()
  })
})

// Twin of test_a_batch_walks_each_run_of_days_once: 2025-11-03 and 11-04 are
// one run of days, walked by one listing; 11-07 holds no general message and
// is walked on its own.
it('walks each run of days of a batch once', async () => {
  const accessor = workspace.accessor()
  const channel = '/mnt/slack/channels/general__C1'
  const days = ['2025-11-03', '2025-11-04', '2025-11-07']
  const chat = new FileStat({
    name: 'chat.jsonl',
    type: FileType.FILE,
    extra: { channel_id: 'C1' },
  })
  const chats = days.map((day) => `${channel}/${day}/chat.jsonl`)
  const each = new Map<string, Uint8Array>()
  for (const [i, day] of days.entries()) {
    const path = chats[i] ?? ''
    each.set(path, await read(accessor, spec(path, '/mnt/slack'), chat, dayRow('C1', day)))
  }
  await workspace.record()
  const answers = await readMany(
    accessor,
    [...chats, '/mnt/slack/users/ana__U1.json'].map((v) => spec(v, '/mnt/slack')),
    1 << 20,
    [...chats.map(() => ({ entry: chat })), {}],
  )
  expect(chats.map((c) => texts(answers.get(c)))).toEqual(chats.map((c) => texts(each.get(c))))
  expect(answers.size).toBe(3)
  expect((await workspace.run.params('GET', HISTORY)).map((p) => [p.oldest, p.latest])).toEqual([
    ['1762128000.000000', '1762300800.000000'],
    ['1762473600.000000', '1762560000.000000'],
  ])
  // A day past the limit is left out: the first day's two messages pass a
  // limit the second day's one fits. A run whose messages pass the limit a day
  // stops walking and is left out whole, the second day too though it would
  // fit on its own.
  const first = each.get(chats[0] ?? '')?.byteLength ?? 0
  const second = each.get(chats[1] ?? '')?.byteLength ?? 0
  for (const [size, kept] of [
    [first - 1, [chats[1], chats[2]]],
    [Math.floor((first + second) / 2) - 1, [chats[2]]],
    [1, [chats[2]]],
  ] as const) {
    const got = await readMany(
      accessor,
      chats.map((v) => spec(v, '/mnt/slack')),
      size,
      chats.map(() => ({ entry: chat })),
    )
    expect([...got.keys()]).toEqual(kept)
  }
})

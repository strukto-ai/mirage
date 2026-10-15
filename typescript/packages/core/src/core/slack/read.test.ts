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
import { SlackAccessor } from '../../accessor/slack.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
import { follow, read, readMany, readStream } from './read.ts'

interface Call {
  endpoint: string
  params?: Record<string, string>
  body?: unknown
}

class FakeTransport implements SlackTransport {
  public readonly calls: Call[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse,
  ) {}
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(endpoint, params))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const decoder = new TextDecoder()

describe('read jsonl branch', () => {
  it('reads channel jsonl bytes via getHistoryJsonl when parent cached', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return {
          ok: true,
          messages: [
            { ts: '1776988900.0', text: 'hello' },
            { ts: '1776989000.0', text: 'world' },
          ],
        }
      }
      return { ok: true }
    })
    const out = await read(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
      idx,
    )
    const text = decoder.decode(out)
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: '1776988900.0', text: 'hello' })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ ts: '1776989000.0', text: 'world' })
    const histCall = t.calls.find((c) => c.endpoint === 'conversations.history')
    expect(histCall?.params?.channel).toBe('C1')
  })

  it('reads dm jsonl bytes when parent cached', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/dms', [
      [
        'alice__D1',
        new IndexEntry({
          id: 'D1',
          name: 'alice',
          resourceType: 'slack/dm',
          vfsName: 'alice__D1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: '1776988850.0', text: 'hi' }] }
      }
      return { ok: true }
    })
    const out = await read(
      new SlackAccessor(t),
      spec('/mnt/slack/dms/alice__D1/2026-04-24/chat.jsonl', '/mnt/slack'),
      idx,
    )
    const text = decoder.decode(out).trimEnd()
    expect(JSON.parse(text)).toMatchObject({ ts: '1776988850.0', text: 'hi' })
    const histCall = t.calls.find((c) => c.endpoint === 'conversations.history')
    expect(histCall?.params?.channel).toBe('D1')
  })

  it('throws ENOENT for jsonl path when index is undefined', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(
        new SlackAccessor(t),
        spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for jsonl path when parent not cached', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(
        new SlackAccessor(t),
        spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read users branch', () => {
  it('returns JSON-stringified user profile bytes', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/users', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'slack/user',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'users.info') {
        return {
          ok: true,
          user: { id: 'U1', name: 'alice', real_name: 'Alice A' },
        }
      }
      return { ok: true }
    })
    const out = await read(
      new SlackAccessor(t),
      spec('/mnt/slack/users/alice__U1.json', '/mnt/slack'),
      idx,
    )
    const parsed = JSON.parse(decoder.decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({ id: 'U1', name: 'alice', real_name: 'Alice A' })
    const infoCall = t.calls.find((c) => c.endpoint === 'users.info')
    expect(infoCall?.params?.user).toBe('U1')
  })

  it('throws ENOENT for users path without index', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(new SlackAccessor(t), spec('/mnt/slack/users/alice__U1.json', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for users path when not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(new SlackAccessor(t), spec('/mnt/slack/users/alice__U1.json', '/mnt/slack'), idx),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(new SlackAccessor(t), spec('/mnt/slack/foo/bar', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR for root', async () => {
    // The root exists by construction, so reading it as a file is the one
    // shape the kit reports as a directory rather than absent.
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      read(new SlackAccessor(t), spec('/mnt/slack', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

it('closes an attachment stream before fetching its tail', async () => {
  let closed = false
  async function* source() {
    try {
      yield await Promise.resolve(new TextEncoder().encode('first\n'))
      throw new Error('fetched tail')
    } finally {
      closed = true
    }
  }
  const index = new RAMIndexCacheStore()
  const path = spec('/channels/general__C1/2026-04-24/files/report__F1.txt')
  await index.setDir(path.virtual.slice(0, path.virtual.lastIndexOf('/')), [
    [
      'report__F1.txt',
      new IndexEntry({
        id: 'F1',
        name: 'report.txt',
        vfsName: 'report__F1.txt',
        resourceType: 'slack/file',
        extra: { url_private_download: 'https://cdn.test/report' },
      }),
    ],
  ])
  try {
    const stream = readStream(
      new SlackAccessor({ call: () => Promise.resolve({ ok: true }), downloadFileStream: source }),
      path,
      index,
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
  const index = new RAMIndexCacheStore()
  const path = spec('/channels/general__C1/2026-04-24/files/report__F1.txt')
  const bytes = new Uint8Array(40_000).fill(65)
  const downloadFile = vi.fn().mockResolvedValue(bytes)
  await index.setDir(path.virtual.slice(0, path.virtual.lastIndexOf('/')), [
    [
      'report__F1.txt',
      new IndexEntry({
        id: 'F1',
        name: 'report.txt',
        vfsName: 'report__F1.txt',
        resourceType: 'slack/file',
        extra: { url_private_download: 'https://cdn.test/report' },
      }),
    ],
  ])
  const received: Uint8Array[] = []
  for await (const chunk of readStream(
    new SlackAccessor({ call: () => Promise.resolve({ ok: true }), downloadFile }),
    path,
    index,
  ))
    received.push(chunk)
  expect(received.map((chunk) => chunk.byteLength)).toEqual([16384, 16384, 7232])
  expect(received.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(bytes.byteLength)
  expect(downloadFile).toHaveBeenCalledWith('https://cdn.test/report', 0, null)
})

describe('follow', () => {
  it('prints the last lines, then asks after the last one seen', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint, params) => {
      if (endpoint !== 'conversations.history') return { ok: true }
      if (params?.oldest === '1776989000.0') {
        return { ok: true, messages: [{ ts: '1776989100.0', text: 'later' }] }
      }
      return {
        ok: true,
        messages: [
          { ts: '1776988900.0', text: 'hello' },
          { ts: '1776989000.0', text: 'world' },
        ],
      }
    })
    const stream = await follow(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
      1,
      0.001,
      idx,
    )
    if (stream === null) throw new Error('the chat day was not followed')
    const it = stream[Symbol.asyncIterator]()
    const texts = async (): Promise<string[]> =>
      decoder
        .decode(((await it.next()).value as Uint8Array | undefined) ?? new Uint8Array())
        .trimEnd()
        .split('\n')
        .map((line) => (JSON.parse(line) as { text: string }).text)
    expect(await texts()).toEqual(['world'])
    expect(await texts()).toEqual(['later'])
    const idle = it.next()
    await it.return?.()
    expect((await idle).done).toBe(true)
    const asked = t.calls.filter((c) => c.endpoint === 'conversations.history')
    expect(asked.map((c) => c.params?.oldest)).toContain('1776989000.0')
  })

  it('follows only a chat day', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    expect(
      await follow(
        new SlackAccessor(t),
        spec('/mnt/slack/users/alice__U1.json', '/mnt/slack'),
        1,
        1,
      ),
    ).toBeNull()
  })
})

// Twin of test_a_batch_walks_each_run_of_days_once.
it('walks each run of days of a batch once', async () => {
  const idx = new RAMIndexCacheStore()
  const channel = '/mnt/slack/channels/general__C1'
  await idx.setDir('/mnt/slack/channels', [
    [
      'general__C1',
      new IndexEntry({
        id: 'C1',
        name: 'general',
        resourceType: 'slack/channel',
        vfsName: 'general__C1',
      }),
    ],
  ])
  const days = ['2026-04-24', '2026-04-25', '2026-04-27']
  for (const day of days) {
    await idx.setDir(`${channel}/${day}`, [
      [
        'chat.jsonl',
        new IndexEntry({
          id: `C1:${day}:chat`,
          name: 'chat.jsonl',
          resourceType: 'slack/chat_jsonl',
          vfsName: 'chat.jsonl',
        }),
      ],
    ])
  }
  const on24 = { ts: '1776988900.000000', text: 'a' }
  const on25 = { ts: '1777075300.000000', text: 'b' }
  const t = new FakeTransport(() => ({ ok: true, messages: [on24, on25] }))
  const chats = days.map((day) => `${channel}/${day}/chat.jsonl`)
  const answers = await readMany(
    new SlackAccessor(t),
    [...chats, '/mnt/slack/users/alice__U1.json'].map((v) => spec(v, '/mnt/slack')),
    1 << 20,
    idx,
  )
  const lines = (body: Uint8Array | undefined): unknown[] =>
    decoder
      .decode(body)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as unknown)
  expect(chats.map((chat) => lines(answers.get(chat)))).toEqual([[on24], [on25], []])
  expect(answers.size).toBe(3)
  expect(t.calls.filter((call) => call.endpoint === 'conversations.history')).toHaveLength(2)
  // A day past the limit is left out; a run past the limit a day stops walking
  // and is left out whole.
  const big = { ts: on24.ts, text: 'a'.repeat(12) }
  const sized = new FakeTransport((_endpoint, params) => ({
    ok: true,
    messages: Number(params?.oldest) < Date.parse('2026-04-26T00:00:00Z') / 1000 ? [big, on25] : [],
  }))
  const limit = new TextEncoder().encode(`${JSON.stringify(on25)}\n`).byteLength + 10
  for (const [size, kept] of [
    [limit, [chats[1], chats[2]]],
    [1, [chats[2]]],
  ] as const) {
    const got = await readMany(
      new SlackAccessor(sized),
      chats.map((v) => spec(v, '/mnt/slack')),
      size,
      idx,
    )
    expect([...got.keys()]).toEqual(kept)
  }
})

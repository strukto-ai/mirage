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
import { describe, expect, it } from 'vitest'
import { SlackAccessor } from '../../accessor/slack.ts'
import { ContentType, FileType, PathSpec, type FileStat } from '../../types.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SlackApiError, type SlackResponse, type SlackTransport } from './client.ts'
import { stat } from './stat.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse | Error,
  ) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    const result = this.responder(endpoint, params)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

function blob(id: string, name: string, mimetype: string, size: number): Record<string, unknown> {
  return { id, name, mimetype, size, url_private_download: 'u' }
}

const MESSAGES = [
  {
    ts: '1775800000.000100',
    text: 'hi',
    files: [
      blob('F1', 'report.pdf', 'application/pdf', 4096),
      blob('F2', 'notes.txt', 'text/plain', 128),
      blob('F3', 'data.bin', 'application/octet-stream', 2048),
    ],
  },
]

// The listings a walk of the workspace makes: one channel, one DM, one user,
// a history of `messages`, or `sealed`'s error for it.
function world(messages: unknown[] = MESSAGES, sealed: string | null = null) {
  return (endpoint: string, params?: Record<string, string>): SlackResponse | Error => {
    if (endpoint === 'conversations.list') {
      const channels =
        params?.types === 'im,mpim'
          ? [{ id: 'D1', user: 'U1', created: 0 }]
          : [{ id: 'C1', name: 'general', created: 1609459200 }]
      return { ok: true, channels, response_metadata: { next_cursor: '' } }
    }
    if (endpoint === 'users.list') return { ok: true, members: [{ id: 'U1', name: 'alice' }] }
    if (endpoint === 'conversations.history') {
      return sealed !== null
        ? new SlackApiError('conversations.history', sealed)
        : { ok: true, messages }
    }
    return { ok: true }
  }
}

// `path`'s stat through a mount at /mnt/slack, which lists each folder
// above it to hand the backend the rows there.
function statAt(t: SlackTransport, path: string): Promise<FileStat> {
  const vfs = new SlackVFSBase({ accessor: new SlackAccessor(t) })
  return new Workspace({ '/mnt/slack/': vfs }).dispatch('stat', path) as Promise<FileStat>
}

const DAY = '/mnt/slack/channels/general__C1/2026-04-10'

describe('stat virtual roots', () => {
  it('returns DIRECTORY for root with name "/"', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec('/mnt/slack', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(t.calls).toHaveLength(0)
  })

  it.each(['channels', 'dms', 'users'])('returns DIRECTORY for /%s', async (root) => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec(`/mnt/slack/${root}`, '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe(root)
  })
})

describe('stat channel/dm dir', () => {
  it('returns DIRECTORY with extra.channel_id for a listed channel', async () => {
    const out = await statAt(new FakeTransport(world()), '/mnt/slack/channels/general__C1')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
    expect(out.modified).toBe('2021-01-01T00:00:00Z')
  })

  it('throws ENOENT for a channel no listing names', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns DIRECTORY with extra.channel_id for a listed dm', async () => {
    const out = await statAt(new FakeTransport(world()), '/mnt/slack/dms/alice__D1')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('alice__D1')
    expect(out.extra.channel_id).toBe('D1')
  })

  it('propagates a failed parent listing', async () => {
    const t = new FakeTransport((endpoint) =>
      endpoint === 'conversations.list'
        ? new SlackApiError('conversations.list', 'fatal_error')
        : { ok: true },
    )
    await expect(statAt(t, '/mnt/slack/channels/missing__C999')).rejects.toThrow(/fatal_error/)
  })
})

describe('stat user file', () => {
  it('returns JSON with extra.user_id for a listed user', async () => {
    const out = await statAt(new FakeTransport(world()), '/mnt/slack/users/alice__U1.json')
    expect(out.content).toBe(ContentType.JSON)
    expect(out.name).toBe('alice__U1.json')
    expect(out.extra.user_id).toBe('U1')
  })

  it('throws ENOENT for a user no listing names', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/users/alice__U1.json', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat date directory', () => {
  it('returns DIRECTORY with the date for a listed channel', async () => {
    const out = await statAt(new FakeTransport(world()), DAY)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-10')
  })

  it('returns DIRECTORY with the date for a listed dm', async () => {
    const out = await statAt(new FakeTransport(world()), '/mnt/slack/dms/alice__D1/2026-04-24')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-24')
  })

  it('throws ENOENT for a date under a bogus channel', async () => {
    await expect(
      statAt(new FakeTransport(world()), '/mnt/slack/channels/nope__C9/2026-04-24'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for a name that is not a date', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1/notadate', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat chat.jsonl and files dir', () => {
  it('sizes chat.jsonl from the day listing', async () => {
    const messages = [{ ts: '1775800000.000100', text: 'hello' }]
    const out = await statAt(new FakeTransport(world(messages)), `${DAY}/chat.jsonl`)
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(out.size).toBe(
      new TextEncoder().encode('{"ts":"1775800000.000100","text":"hello"}\n').length,
    )
  })

  it('rejects chat.jsonl absent from a sealed day', async () => {
    // A denied or empty day lists no chat.jsonl; stat must not fabricate a
    // sizeless file for it.
    const t = new FakeTransport(world(MESSAGES, 'not_in_channel'))
    await expect(statAt(t, `${DAY}/chat.jsonl`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns DIRECTORY files for a listed day', async () => {
    const out = await statAt(new FakeTransport(world()), `${DAY}/files`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('files')
  })

  it('throws ENOENT for files under a sealed day', async () => {
    // A sealed day lists nothing, so its files subdir does not exist.
    const t = new FakeTransport(world(MESSAGES, 'not_in_channel'))
    await expect(statAt(t, `${DAY}/files`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['report__F1.pdf', ContentType.PDF, 4096],
    ['notes__F2.txt', ContentType.TEXT, 128],
    ['data__F3.bin', ContentType.BINARY, 2048],
  ] as const)('types the blob %s by its mimetype', async (name, content, size) => {
    const out = await statAt(new FakeTransport(world()), `${DAY}/files/${name}`)
    expect(out.content).toBe(content)
    expect(out.size).toBe(size)
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/foo/bar/baz', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

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
import { ContentType, FileType, PathSpec, type FileStat } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, LISTING, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { stat } from './stat.ts'

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

function mounted(): Workspace {
  return new Workspace({ '/mnt/slack/': new SlackVFS({ accessor: workspace.accessor() }) })
}

// `path`'s stat through a mount at /mnt/slack, which lists each folder above
// it to hand the backend the rows there.
function statAt(path: string): Promise<FileStat> {
  return mounted().dispatch('stat', path) as Promise<FileStat>
}

// The day general holds three attachments: a PDF, a text file and one of no
// type Slack names.
const DAY = '/mnt/slack/channels/general__C1/2025-11-08'

describe('stat virtual roots', () => {
  it('returns DIRECTORY for root with name "/"', async () => {
    const out = await stat(workspace.accessor(), spec('/mnt/slack', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(await workspace.run.requests()).toEqual([])
  })

  it.each(['channels', 'dms', 'users'])('returns DIRECTORY for /%s', async (root) => {
    const out = await stat(workspace.accessor(), spec(`/mnt/slack/${root}`, '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe(root)
  })
})

describe('stat channel/dm dir', () => {
  it('returns DIRECTORY with extra.channel_id for a listed channel', async () => {
    const out = await statAt('/mnt/slack/channels/general__C1')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
    // A channel is dated by its creation.
    expect(out.modified).toBe('2025-11-03T00:00:00Z')
  })

  it('throws ENOENT for a channel no listing names', async () => {
    await expect(
      stat(workspace.accessor(), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns DIRECTORY with extra.channel_id for a listed dm', async () => {
    const out = await statAt('/mnt/slack/dms/ana__D1')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('ana__D1')
    expect(out.extra.channel_id).toBe('D1')
  })

  it('propagates a failed parent listing', async () => {
    await workspace.refuse(LISTING, 'fatal_error')
    await expect(statAt('/mnt/slack/channels/missing__C999')).rejects.toThrow(/fatal_error/)
  })
})

describe('stat user file', () => {
  it('returns JSON with extra.user_id for a listed user', async () => {
    const out = await statAt('/mnt/slack/users/ana__U1.json')
    expect(out.content).toBe(ContentType.JSON)
    expect(out.name).toBe('ana__U1.json')
    expect(out.extra.user_id).toBe('U1')
  })

  it('throws ENOENT for a user no listing names', async () => {
    await expect(
      stat(workspace.accessor(), spec('/mnt/slack/users/ana__U1.json', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat date directory', () => {
  it('returns DIRECTORY with the date for a listed channel', async () => {
    const out = await statAt(DAY)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2025-11-08')
  })

  it('returns DIRECTORY with the date for a listed dm', async () => {
    const out = await statAt('/mnt/slack/dms/ana__D1/2025-11-03')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2025-11-03')
  })

  it('throws ENOENT for a date under a bogus channel', async () => {
    await expect(statAt('/mnt/slack/channels/nope__C9/2025-11-03')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a name that is not a date', async () => {
    await expect(
      stat(workspace.accessor(), spec('/mnt/slack/channels/general__C1/notadate', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat chat.jsonl and files dir', () => {
  it('sizes chat.jsonl from the day listing', async () => {
    const chat = '/mnt/slack/channels/general__C1/2025-11-04/chat.jsonl'
    const ws = mounted()
    const out = (await ws.dispatch('stat', chat)) as FileStat
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(out.size).toBe(((await ws.dispatch('read', chat)) as Uint8Array).byteLength)
  })

  it('rejects chat.jsonl in a refused day with EACCES', async () => {
    // A day Slack will not show is not an empty day; stat must neither
    // fabricate a sizeless file nor call it absent.
    const ws = mounted()
    await ws.dispatch('readdir', '/mnt/slack/channels/general__C1')
    await workspace.refuse(HISTORY, 'not_in_channel')
    await expect(ws.dispatch('stat', `${DAY}/chat.jsonl`)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('returns DIRECTORY files for a listed day', async () => {
    const out = await statAt(`${DAY}/files`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('files')
  })

  it('throws EACCES for files under a refused day', async () => {
    const ws = mounted()
    await ws.dispatch('readdir', '/mnt/slack/channels/general__C1')
    await workspace.refuse(HISTORY, 'not_in_channel')
    await expect(ws.dispatch('stat', `${DAY}/files`)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.each([
    ['report__F2.pdf', ContentType.PDF, '%PDF-1.4 the report\n'],
    ['notes__F3.txt', ContentType.TEXT, 'the notes\n'],
    ['data__F4.bin', ContentType.BINARY, '0101'],
  ] as const)('types the blob %s by its mimetype', async (name, content, bytes) => {
    const out = await statAt(`${DAY}/files/${name}`)
    expect(out.content).toBe(content)
    expect(out.size).toBe(new TextEncoder().encode(bytes).byteLength)
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    await expect(
      stat(workspace.accessor(), spec('/mnt/slack/foo/bar/baz', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

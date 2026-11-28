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
import type { DirListing } from '../../types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, LISTING, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { dateRange, latestMessageTs, readdir } from './readdir.ts'

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

// general is created on 2025-11-03 and its latest message is on 11-08.
const START = 1762128000

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

function paths(listed: readonly FileStat[] | DirListing, folder: string): string[] {
  return rowsOf(listed).map((row) => `${folder.replace(/\/$/, '')}/${row.name}`)
}

// A conversation's row as its container's listing names it.
function conversationRow(dirname = 'general__C1', created = 0, name = 'general'): FileStat {
  return new FileStat({
    name: dirname,
    type: FileType.DIRECTORY,
    extra: { channel_id: dirname.split('__').at(-1) ?? '', name, created },
  })
}

// A day's row as its channel's listing names it.
function dayRow(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { channel_id: 'C1' } })
}

function mounted(): Workspace {
  return new Workspace({
    '/mnt/slack/': new SlackVFS({ accessor: workspace.accessor() }),
  })
}

async function routes(): Promise<string[]> {
  return (await workspace.run.requests()).map((r) => r.split(' ')[1] ?? '')
}

const EMPTY = { ok: true, messages: [] }

describe('dateRange', () => {
  it('returns end and start (inclusive) walking backward', () => {
    // 2024-01-03 UTC
    const end = Date.UTC(2024, 0, 3) / 1000
    // 2024-01-01 UTC
    const start = Date.UTC(2024, 0, 1) / 1000
    expect(dateRange(end, start)).toEqual(['2024-01-03', '2024-01-02', '2024-01-01'])
  })

  it('clamps to maxDays when start is older than the limit', () => {
    const end = Date.UTC(2024, 0, 100) / 1000
    const start = Date.UTC(2024, 0, 1) / 1000
    const out = dateRange(end, start, 90)
    expect(out).toHaveLength(90)
    expect(out[0]).toBe(new Date(Date.UTC(2024, 0, 100)).toISOString().slice(0, 10))
    // last entry is end - (maxDays - 1) days
    const lastMs = Date.UTC(2024, 0, 100) - 89 * 86_400_000
    expect(out[out.length - 1]).toBe(new Date(lastMs).toISOString().slice(0, 10))
  })

  it('returns single date when latest equals created', () => {
    const ts = Date.UTC(2024, 5, 15) / 1000
    expect(dateRange(ts, ts)).toEqual(['2024-06-15'])
  })

  it('escapes the cap for a glob span older than the window', () => {
    // A day dir is real for any date the channel has existed for, so a glob
    // older than the 90-day window must still list its days.
    const end = Date.UTC(2024, 0, 100) / 1000
    const start = Date.UTC(2010, 0, 1) / 1000
    const out = dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])
    expect(out).toHaveLength(31)
    expect(out[0]).toBe('2010-03-31')
    expect(out[30]).toBe('2010-03-01')
  })

  it('clips a glob span at both ends of the channel', () => {
    const start = Date.UTC(2010, 2, 10) / 1000
    const end = Date.UTC(2010, 2, 20) / 1000
    const out = dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])
    expect(out[0]).toBe('2010-03-20')
    expect(out[out.length - 1]).toBe('2010-03-10')
  })

  it('lists nothing for a glob span the channel never covered', () => {
    const start = Date.UTC(2020, 0, 1) / 1000
    const end = Date.UTC(2020, 0, 5) / 1000
    expect(dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])).toEqual([])
  })
})

describe('latestMessageTs', () => {
  it('returns float ts of first message', async () => {
    const ts = await latestMessageTs(workspace.accessor(), 'C1')
    expect(ts).toBeCloseTo(1762560060.000001, 5)
    expect(await workspace.run.params('GET', HISTORY)).toEqual([{ channel: 'C1', limit: '1' }])
  })

  it('returns null for empty channel (no messages)', async () => {
    await workspace.run.answerNext('GET', HISTORY, 200, EMPTY)
    expect(await latestMessageTs(workspace.accessor(), 'C1')).toBeNull()
  })
})

describe('readdir root', () => {
  it('returns the three virtual roots for empty key with prefix', async () => {
    const out = await readdir(workspace.accessor(), spec('/mnt/slack', '/mnt/slack'))
    expect(paths(out, '/mnt/slack')).toEqual([
      '/mnt/slack/channels',
      '/mnt/slack/dms',
      '/mnt/slack/users',
    ])
    expect(await workspace.run.requests()).toEqual([])
  })

  it('returns the three virtual roots for empty prefix', async () => {
    const out = await readdir(workspace.accessor(), spec('/'))
    expect(paths(out, '/')).toEqual(['/channels', '/dms', '/users'])
  })
})

describe('readdir /channels', () => {
  it('lists channels with their ids and creation times', async () => {
    const out = await readdir(workspace.accessor(), spec('/mnt/slack/channels', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/channels')).toEqual([
      '/mnt/slack/channels/general__C1',
      '/mnt/slack/channels/random__C2',
    ])
    const [row] = rowsOf(out)
    expect(row?.extra).toEqual({ channel_id: 'C1', name: 'general', created: START })
    expect(row?.modified).not.toBeNull()
  })
})

describe('readdir /dms', () => {
  it('lists DMs and users, builds user_map for dirnames', async () => {
    const out = await readdir(workspace.accessor(), spec('/mnt/slack/dms', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/dms')).toEqual(['/mnt/slack/dms/ana__D1'])
    expect(await routes()).toEqual(expect.arrayContaining([LISTING, '/api/users.list']))
    expect((await workspace.run.params('GET', LISTING))[0]?.types).toBe('im,mpim')
    expect(rowsOf(out)[0]?.extra.name).toBe('ana')
  })
})

describe('readdir /users', () => {
  it('lists users (filters bots/deleted) and writes filenames', async () => {
    // The workspace also holds a bot, a deactivated user and Slackbot.
    const out = await readdir(workspace.accessor(), spec('/mnt/slack/users', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/users')).toEqual([
      '/mnt/slack/users/ana__U1.json',
      '/mnt/slack/users/ben__U2.json',
    ])
    expect(rowsOf(out)[0]?.extra.user_id).toBe('U1')
  })
})

describe('readdir channel/<id> (history dates)', () => {
  it('throws ENOENT with no row for the channel', async () => {
    await expect(
      readdir(workspace.accessor(), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns date filenames bounded by latestMessageTs and created', async () => {
    const out = await readdir(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow('general__C1', START),
    )
    expect(paths(out, '/mnt/slack/channels/general__C1').map((p) => p.slice(-10))).toEqual([
      '2025-11-08',
      '2025-11-07',
      '2025-11-06',
      '2025-11-05',
      '2025-11-04',
      '2025-11-03',
    ])
    expect(rowsOf(out)[1]?.extra).toEqual({ channel_id: 'C1' })
  })

  it('lists the channels above it through a mount', async () => {
    const out = (await mounted().dispatch('readdir', '/mnt/slack/channels/general__C1')) as string[]
    expect(out[0]).toBe('/mnt/slack/channels/general__C1/2025-11-08')
    expect(out.at(-1)).toBe('/mnt/slack/channels/general__C1/2025-11-03')
    expect(await routes()).toEqual(expect.arrayContaining([LISTING, HISTORY]))
  })

  it('throws ENOENT when no listing names the channel', async () => {
    await expect(
      mounted().dispatch('readdir', '/mnt/slack/channels/general__CX'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns no dates when channel has no messages and no created', async () => {
    await workspace.run.answerNext('GET', HISTORY, 200, EMPTY)
    const out = await readdir(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow(),
    )
    expect(rowsOf(out)).toEqual([])
  })

  it('skips tombstoned and access-restricted file payloads', async () => {
    // Such payloads carry an id but no download URL and no size; listing
    // them would surface phantom files and break sizesAlwaysKnown. Slack's
    // own page for the day, with two of its three files made so.
    const page = await workspace.run.call<{ messages: { files: Record<string, unknown>[] }[] }>(
      'GET',
      `${HISTORY}?channel=C1&oldest=1762560000&latest=1762646400&inclusive=true`,
    )
    const files = page.messages[0]?.files ?? []
    files[1] = { id: files[1]?.id, mode: 'tombstone' }
    files[2] = { id: files[2]?.id, name: files[2]?.name, file_access: 'check_file_info' }
    await workspace.run.answerNext('GET', HISTORY, 200, page as never)
    const listed = (await readdir(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1/2025-11-08', '/mnt/slack'),
      dayRow('2025-11-08'),
    )) as DirListing
    const blobs = listed.seeds.get('files') ?? []
    expect(blobs.map((row) => row.name)).toEqual(['report__F2.pdf'])
    expect(blobs[0]?.size).toBe(new TextEncoder().encode('%PDF-1.4 the report\n').byteLength)
  })
})

describe('readdir of an end-scoped conversation without a creation time', () => {
  // ana's DM: a message on 2025-11-03 and one on 11-06, after the end.
  const end = Date.UTC(2025, 10, 5) / 1000
  const dm = conversationRow('ana__D1', 0, 'ana')
  const scoped = () => workspace.accessor({ endTime: '2025-11-05T00:00:00Z' })

  it('takes a glob span as its first day instead of scanning history', async () => {
    const out = paths(
      await readdir(
        scoped(),
        new PathSpec({
          virtual: '/mnt/slack/dms/ana__D1/2025-10-*',
          directory: '/mnt/slack/dms/ana__D1/',
          vfsPath: mountKey('/mnt/slack/dms/ana__D1/2025-10-*', '/mnt/slack'),
          pattern: '2025-10-*',
        }),
        dm,
      ),
      '/mnt/slack/dms/ana__D1',
    )
    // Only the latest message is asked for, never the history before it.
    expect(await workspace.run.params('GET', HISTORY)).toEqual([{ channel: 'D1', limit: '1' }])
    expect(out).toHaveLength(31)
    expect(out[0]).toBe('/mnt/slack/dms/ana__D1/2025-10-31')
    expect(out[30]).toBe('/mnt/slack/dms/ana__D1/2025-10-01')
  })

  it('pages only the history before the end for a bare listing', async () => {
    const out = await readdir(scoped(), spec('/mnt/slack/dms/ana__D1', '/mnt/slack'), dm)
    expect(await workspace.run.params('GET', HISTORY)).toEqual([
      { channel: 'D1', limit: '1' },
      { channel: 'D1', limit: '200', latest: end.toFixed(6) },
    ])
    expect(paths(out, '/mnt/slack/dms/ana__D1')).toEqual([
      '/mnt/slack/dms/ana__D1/2025-11-04',
      '/mnt/slack/dms/ana__D1/2025-11-03',
    ])
  })
})

describe('readdir channel window', () => {
  it('lists a channel as a window', async () => {
    // The bare listing covers the last 90 days only; a day that falls out
    // of it still exists and is still readable by path.
    const out = await readdir(
      workspace.accessor(),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow('general__C1', START),
    )
    expect((out as DirListing).window).toBe(true)
  })
})

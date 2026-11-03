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

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return {
    ...actual,
    boxGet: vi.fn(),
    boxOptions: vi.fn(),
    boxPostJson: vi.fn(),
    boxUploadMultipart: vi.fn(),
    boxUploadSession: vi.fn(),
  }
})

import * as client from './client.ts'
import { BoxApiError, BoxTokenManager } from './client.ts'
import { runWithWriteContext } from '../../cache/context.ts'
import type { Measured } from '../../cache/types.ts'
import { keptVersions, sameBytes } from '../../test-utils.ts'
import { isStaleWrite } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { ByteSpool } from '../../io/spool.ts'
import { PathSpec } from '../../types.ts'
import {
  createFolder,
  eventsNow,
  eventsSince,
  listFolderItems,
  realtimeServer,
  refused,
  uploadFileVersion,
  uploadNewFile,
} from './api.ts'

const TM = { apiBase: 'https://api.box.com/2.0' } as BoxTokenManager

beforeEach(() => {
  vi.clearAllMocks()
})

// Twin of test_list_folder_items_counts_no_web_link_toward_a_limit.
it('counts no web link toward a listing limit', async () => {
  vi.mocked(client.boxGet)
    .mockResolvedValueOnce({
      total_count: 4,
      entries: [
        { id: '1', name: 'a', type: 'web_link' },
        { id: '2', name: 'b', type: 'web_link' },
      ],
    })
    .mockResolvedValueOnce({
      total_count: 4,
      entries: [
        { id: '3', name: 'c', type: 'file' },
        { id: '4', name: 'd', type: 'file' },
      ],
    })
  const items = await listFolderItems(TM, '0', { pageSize: 2, limit: 2 })
  expect(items.map((item) => item.id)).toEqual(['1', '2', '3', '4'])
  expect(vi.mocked(client.boxGet)).toHaveBeenCalledTimes(2)
})

describe('box events api', () => {
  it('reads events until an empty page', async () => {
    // Box may return a short page while more events remain, so only an
    // empty page ends the read.
    vi.mocked(client.boxGet)
      .mockResolvedValueOnce({
        chunk_size: 1,
        next_stream_position: 11,
        entries: [{ event_id: 'a' }],
      })
      .mockResolvedValueOnce({
        chunk_size: 1,
        next_stream_position: '12',
        entries: [{ event_id: 'b' }],
      })
      .mockResolvedValueOnce({ chunk_size: 0, next_stream_position: '12', entries: [] })
    const found = await eventsSince(TM, '10', 'changes')
    expect(found.entries.map((e) => e.event_id)).toEqual(['a', 'b'])
    expect(found.position).toBe('12')
    const calls = vi.mocked(client.boxGet).mock.calls
    expect(calls.map((c) => c[2]?.stream_position)).toEqual(['10', '11', '12'])
    expect(calls[0]?.[1]).toBe('https://api.box.com/2.0/events')
    expect(calls[0]?.[2]?.stream_type).toBe('changes')
  })

  it('returns the stream head for now', async () => {
    vi.mocked(client.boxGet).mockResolvedValueOnce({
      chunk_size: 0,
      next_stream_position: '1152922976252290886',
      entries: [],
    })
    expect(await eventsNow(TM, 'changes')).toBe('1152922976252290886')
    expect(vi.mocked(client.boxGet).mock.calls[0]?.[2]?.stream_position).toBe('now')
  })

  it('asks OPTIONS /events for the long-poll server', async () => {
    const server = {
      type: 'realtime_server',
      url: 'http://2.realtime.services.box.net/subscribe?channel=c',
      ttl: '10',
      max_retries: '10',
      retry_timeout: 610,
    }
    vi.mocked(client.boxOptions).mockResolvedValueOnce({ chunk_size: 1, entries: [server] })
    expect((await realtimeServer(TM)).url).toBe(server.url)
    expect(vi.mocked(client.boxOptions).mock.calls[0]?.[1]).toBe('https://api.box.com/2.0/events')
  })

  it.each([null, '10', 10])('refuses events that do not advance (%s)', async (stuck) => {
    vi.mocked(client.boxGet).mockResolvedValueOnce({
      chunk_size: 1,
      next_stream_position: stuck,
      entries: [{ event_id: 'a' }],
    })
    await expect(eventsSince(TM, '10', 'changes')).rejects.toThrow('did not advance')
  })

  it('keeps its position on an empty page without one', async () => {
    vi.mocked(client.boxGet)
      .mockResolvedValueOnce({
        chunk_size: 1,
        next_stream_position: '11',
        entries: [{ event_id: 'a' }],
      })
      .mockResolvedValueOnce({ chunk_size: 0, entries: [] })
    const found = await eventsSince(TM, '10', 'changes')
    expect(found.entries.map((e) => e.event_id)).toEqual(['a'])
    expect(found.position).toBe('11')
  })

  it('refuses a stream head without a position', async () => {
    vi.mocked(client.boxGet).mockResolvedValueOnce({ chunk_size: 0, entries: [] })
    await expect(eventsNow(TM, 'changes')).rejects.toThrow('next_stream_position')
  })

  it('refuses an OPTIONS answer without a realtime server', async () => {
    vi.mocked(client.boxOptions).mockResolvedValueOnce({ chunk_size: 0 })
    await expect(realtimeServer(TM)).rejects.toThrow('realtime server')
  })
})

async function uploadUrls(tm: BoxTokenManager): Promise<unknown[]> {
  vi.mocked(client.boxUploadMultipart).mockResolvedValue({})
  await uploadNewFile(tm, '0', 'a.txt', new Uint8Array([97]))
  await uploadFileVersion(tm, '7', 'a.txt', new Uint8Array([98]))
  return vi.mocked(client.boxUploadMultipart).mock.calls.map((c) => c[1])
}

describe('box upload host', () => {
  it('sends uploads to the upload host', async () => {
    expect(await uploadUrls(new BoxTokenManager({ accessToken: 'tok' }))).toEqual([
      'https://upload.box.com/api/2.0/files/content',
      'https://upload.box.com/api/2.0/files/7/content',
    ])
  })

  it('keeps folder calls on the api host', async () => {
    vi.mocked(client.boxPostJson).mockResolvedValue({})
    await createFolder(new BoxTokenManager({ accessToken: 'tok' }), '0', 'd')
    expect(vi.mocked(client.boxPostJson).mock.calls[0]?.[1]).toBe('https://api.box.com/2.0/folders')
  })

  it('sends uploads to an endpoint override', async () => {
    const tm = new BoxTokenManager({ accessToken: 'tok', endpoint: 'http://127.0.0.1:5096/' })
    expect(await uploadUrls(tm)).toEqual([
      'http://127.0.0.1:5096/2.0/files/content',
      'http://127.0.0.1:5096/2.0/files/7/content',
    ])
  })
})

interface LostCase {
  name: string
  status: number
  outcome: 'lost' | 'gone' | 'other'
}

const LOST = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/fixtures/write/drive_lost_codes.json', import.meta.url),
    'utf-8',
  ),
) as { box: LostCase[] }

async function refuse(
  err: BoxApiError,
  sent: string | null,
): Promise<[Measured[], StaleWriteError | null]> {
  const { context, kept } = keptVersions('box')
  const path = new PathSpec({ virtual: '/box/f', directory: '/box/', vfsPath: '/f' })
  const got = await runWithWriteContext('/box/', context, () =>
    refused(path, err, { kind: 'match', version: 's1' }, sent),
  )
  return [kept, got]
}

describe('refused', () => {
  const rows = LOST.box.flatMap((c) => [[c.name, 'e1', c] as const, [c.name, null, c] as const])
  it.each(rows)('reads Box answers like the shared table: %s, sent %s', async (_name, sent, c) => {
    const [kept, got] = await refuse(new BoxApiError('x', c.status), sent)
    if (sent === null || c.outcome === 'other') expect([kept, got]).toEqual([[], null])
    else {
      expect(isStaleWrite(got)).toBe(true)
      expect(kept).toEqual(['s1'])
    }
  })
})

const MIB = 1024 * 1024
const UPLOAD = 'https://upload.box.com/api/2.0/files'

// Box takes up to 50 MB in one files/content request and opens an upload
// session from 20,000,000 bytes (its API docs, not probed); from 20 MiB an
// upload takes a session whatever holds the bytes.
describe('box upload protocol', () => {
  it.each(
    [false, true].flatMap((versioning) =>
      [false, true].flatMap((spooled) =>
        [20 * MIB - 1, 20 * MIB].map((size) => [versioning, spooled, size] as const),
      ),
    ),
  )('a box upload from 20 MiB goes through a session: version %s, spooled %s, %i bytes', async (versioning, spooled, size) => {
    const tm = new BoxTokenManager({ accessToken: 'tok' })
    const payload = new Uint8Array(size).fill(97)
    const spool = new ByteSpool()
    await spool.append(payload)
    const data = spooled ? spool : payload
    vi.mocked(client.boxUploadSession).mockResolvedValue({ via: 'session' })
    vi.mocked(client.boxUploadMultipart).mockResolvedValue({ via: 'multipart' })
    try {
      const reply = versioning
        ? await uploadFileVersion(tm, '7', 'a.txt', data, '"v1"')
        : await uploadNewFile(tm, '0', 'a.txt', data)
      if (size < 20 * MIB) {
        expect(reply).toEqual({ via: 'multipart' })
        expect(client.boxUploadSession).not.toHaveBeenCalled()
        const sent = vi.mocked(client.boxUploadMultipart).mock.calls[0] ?? []
        expect(sameBytes(sent[4], payload)).toBe(true)
        expect(sent[5]).toEqual(versioning ? { 'If-Match': '"v1"' } : undefined)
        return
      }
      expect(reply).toEqual({ via: 'session' })
      expect(client.boxUploadMultipart).not.toHaveBeenCalled()
      const args = vi.mocked(client.boxUploadSession).mock.calls[0] ?? []
      // The input itself: a spool is streamed from, never read into memory.
      expect(args[3]).toBe(data)
      expect([...args.slice(0, 3), ...args.slice(4)]).toEqual(
        versioning
          ? [tm, `${UPLOAD}/7/upload_sessions`, { file_name: 'a.txt' }, '"v1"']
          : [tm, `${UPLOAD}/upload_sessions`, { folder_id: '0', file_name: 'a.txt' }],
      )
    } finally {
      await spool.close()
    }
  })
})

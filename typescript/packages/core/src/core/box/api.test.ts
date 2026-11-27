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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

// Each call goes through to the real client; only the host and session
// tests below, which a single-origin fake cannot show, stub one call.
vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return {
    ...actual,
    boxPostJson: vi.fn(actual.boxPostJson),
    boxUploadMultipart: vi.fn(actual.boxUploadMultipart),
    boxUploadSession: vi.fn(actual.boxUploadSession),
  }
})

import * as client from './client.ts'
import { BoxApiError, BoxTokenManager } from './client.ts'
import { runWithWriteContext } from '../../cache/context.ts'
import type { Measured } from '../../cache/types.ts'
import { keptVersions } from '../../test-utils.ts'
import { isStaleWrite } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { ByteSpool } from '../../io/spool.ts'
import { PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  createFolder,
  eventsNow,
  eventsSince,
  listFolderItems,
  realtimeServer,
  refused,
  searchContent,
  uploadFileVersion,
  uploadNewFile,
} from './api.ts'

const ITEMS_ROUTE = '/2.0/folders/:folder_id/items'
const SEARCH_ROUTE = '/2.0/search'
const EVENTS_ROUTE = '/2.0/events'
// Box spells a stream position as a JSON number near 1.15e18, past the 2**53
// a JavaScript number holds exactly; the kit parses a plan in JavaScript, so
// an answer carrying one is sent as written.
const POSITION = '1152922976252290886'
const ENC = new TextEncoder()

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

// A reset puts each stub back to the real call and drops a one-shot answer
// a test left unused.
beforeEach(() => {
  vi.resetAllMocks()
  account = new BoxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function tm(): BoxTokenManager {
  return account.accessor().tokenManager
}

describe('box listing', () => {
  it('follows offset pagination', async () => {
    for (const name of ['a', 'b', 'c']) await account.put(name, new Uint8Array([120]))
    await account.run.recordRequests()
    const items = await listFolderItems(tm(), '0', { pageSize: 2 })
    expect(items.map((item) => item.name)).toEqual(['a', 'b', 'c'])
    const pages = await account.run.params('GET', ITEMS_ROUTE)
    expect(pages.map((page) => page.offset)).toEqual(['0', '2'])
  })

  // Twin of test_list_folder_items_counts_no_web_link_toward_a_limit. Box
  // lists the two web links first, by name; a limit counted them would stop
  // after that page.
  it('counts no web link toward a listing limit', async () => {
    await account.webLink('a')
    await account.webLink('b')
    await account.put('c', new Uint8Array([120]))
    await account.put('d', new Uint8Array([120]))
    await account.run.recordRequests()
    const items = await listFolderItems(tm(), '0', { pageSize: 2, limit: 2 })
    expect(items.map((item) => item.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(await account.run.params('GET', ITEMS_ROUTE)).toHaveLength(2)
  })

  it('stops on an empty page', async () => {
    await account.run.answerNext('GET', ITEMS_ROUTE, 200, { total_count: 5, entries: [] })
    await account.run.recordRequests()
    expect(await listFolderItems(tm(), '0')).toEqual([])
    expect(await account.run.params('GET', ITEMS_ROUTE)).toHaveLength(1)
  })
})

describe('box search', () => {
  // Only a file under the folder, found by its content: the name match
  // outside the folder and the folder named like the query are not.
  it('scopes to the folder and matches content', async () => {
    const folder = await account.mkdir('scope')
    const hit = await account.put('hit', new TextEncoder().encode('one needle here'), folder)
    await account.put('needle.txt', new Uint8Array([120]))
    await account.mkdir('needle', folder)
    await account.run.recordRequests()
    const { items, truncated } = await searchContent(tm(), 'needle', folder)
    expect(items.map((item) => item.id)).toEqual([hit])
    expect(truncated).toBe(false)
    expect(await account.run.params('GET', SEARCH_ROUTE)).toEqual([
      expect.objectContaining({
        ancestor_folder_ids: folder,
        content_types: 'name,file_content',
        type: 'file',
        fields: 'id,name,type,path_collection',
      }),
    ])
  })

  // More hits than the fake would hold: Box's own pages of 200.
  it('flags truncation at the ceiling', async () => {
    const page = {
      total_count: 20_000,
      entries: Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: 'f', type: 'file' })),
    }
    await account.run.answerNext('GET', SEARCH_ROUTE, 200, page, 60)
    const { items, truncated } = await searchContent(tm(), 'q', '0')
    expect(truncated).toBe(true)
    expect(items.length).toBeGreaterThanOrEqual(10_000)
  })
})

describe('box events api', () => {
  it('reads events until an empty page', async () => {
    // Box may return a short page while more events remain, so only an
    // empty page ends the read: its first page is answered short here.
    await account.mkdir('x')
    await account.put('a.txt', new Uint8Array([97]))
    const whole = await account.run.call<{ entries: JsonValue[]; next_stream_position: string }>(
      'GET',
      '/2.0/events?stream_position=0',
    )
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, {
      chunk_size: 1,
      next_stream_position: 1,
      entries: [whole.entries[0] ?? null],
    })
    await account.run.recordRequests()
    const found = await eventsSince(tm(), '0', 'changes')
    expect(found.entries).toEqual(whole.entries)
    expect(found.position).toBe(whole.next_stream_position)
    const sent = await account.run.params('GET', EVENTS_ROUTE)
    expect(sent.map((p) => p.stream_position)).toEqual(['0', '1', '2'])
    expect(new Set(sent.map((p) => p.stream_type))).toEqual(new Set(['changes']))
  })

  it('returns the stream head for now', async () => {
    await account.mkdir('x')
    await account.run.recordRequests()
    expect(await eventsNow(tm(), 'changes')).toBe('1')
    expect((await account.run.params('GET', EVENTS_ROUTE))[0]?.stream_position).toBe('now')
    const head = `{"chunk_size": 0, "next_stream_position": ${POSITION}, "entries": []}`
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, ENC.encode(head))
    expect(await eventsNow(tm(), 'changes')).toBe(POSITION)
  })

  // Twin of test_events_since_sends_back_a_position_as_box_wrote_it: a
  // position read into a number comes back as a neighbour, and the next read
  // from it repeats or skips events.
  it('sends back a position as Box wrote it', async () => {
    const page = `{"chunk_size": 1, "next_stream_position": ${POSITION}, "entries": [{"event_id": "a"}]}`
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, ENC.encode(page))
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, { chunk_size: 0, entries: [] })
    await account.run.recordRequests()
    const found = await eventsSince(tm(), '10', 'changes')
    expect([found.entries.map((e) => e.event_id), found.position]).toEqual([['a'], POSITION])
    const sent = await account.run.params('GET', EVENTS_ROUTE)
    expect(sent.map((p) => p.stream_position)).toEqual(['10', POSITION])
  })

  it('asks OPTIONS /events for the long-poll server', async () => {
    const answer = await account.run.call<{ entries: { url: string }[] }>('OPTIONS', EVENTS_ROUTE)
    await account.run.recordRequests()
    expect((await realtimeServer(tm())).url).toBe(answer.entries[0]?.url)
    expect(await account.run.requests()).toEqual(['OPTIONS /2.0/events'])
  })

  it.each([null, '10', 10])('refuses events that do not advance (%s)', async (stuck) => {
    const page = { chunk_size: 1, next_stream_position: stuck, entries: [{ event_id: 'a' }] }
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, page, 2)
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, { entries: [] })
    await expect(eventsSince(tm(), '10', 'changes')).rejects.toThrow('did not advance')
  })

  it('keeps its position on an empty page without one', async () => {
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, {
      chunk_size: 1,
      next_stream_position: '11',
      entries: [{ event_id: 'a' }],
    })
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, { chunk_size: 0, entries: [] })
    const found = await eventsSince(tm(), '10', 'changes')
    expect(found.entries.map((e) => e.event_id)).toEqual(['a'])
    expect(found.position).toBe('11')
  })

  it('refuses a stream head without a position', async () => {
    await account.run.answerNext('GET', EVENTS_ROUTE, 200, { chunk_size: 0, entries: [] })
    await expect(eventsNow(tm(), 'changes')).rejects.toThrow('next_stream_position')
  })

  it('refuses an OPTIONS answer without a realtime server', async () => {
    await account.run.answerNext('OPTIONS', EVENTS_ROUTE, 200, { chunk_size: 0 })
    await expect(realtimeServer(tm())).rejects.toThrow('realtime server')
  })
})

async function uploadUrls(tm: BoxTokenManager): Promise<unknown[]> {
  vi.mocked(client.boxUploadMultipart).mockResolvedValueOnce({}).mockResolvedValueOnce({})
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
    vi.mocked(client.boxPostJson).mockResolvedValueOnce({})
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
  )(
    'a box upload from 20 MiB goes through a session: version %s, spooled %s, %i bytes',
    async (versioning, spooled, size) => {
      const tm = new BoxTokenManager({ accessToken: 'tok' })
      const payload = new Uint8Array(size).fill(97)
      const spool = new ByteSpool()
      await spool.append(payload)
      const data = spooled ? spool : payload
      vi.mocked(client.boxUploadSession).mockResolvedValueOnce({ via: 'session' })
      vi.mocked(client.boxUploadMultipart).mockResolvedValueOnce({ via: 'multipart' })
      try {
        const reply = versioning
          ? await uploadFileVersion(tm, '7', 'a.txt', data, '"v1"')
          : await uploadNewFile(tm, '0', 'a.txt', data)
        if (size < 20 * MIB) {
          expect(reply).toEqual({ via: 'multipart' })
          expect(client.boxUploadSession).not.toHaveBeenCalled()
          const sent = vi.mocked(client.boxUploadMultipart).mock.calls[0] ?? []
          expect(Buffer.compare(sent[4] ?? new Uint8Array(), payload)).toBe(0)
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
    },
  )
})

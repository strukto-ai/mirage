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

import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError } from '../hf_hub/client.ts'
import { FakeHub, INVALID_PATHS, NO_ETAG, lfsOid, serveHub, xetHash } from '../hf_hub/_test_util.ts'
import { fetchRow, pathsInfoUrl, readToken, resolveUrl } from './hub.ts'
import { DEAD_ENDPOINT, fakeHfOperator, installFakeOperator } from './mock.ts'
import { read } from './read.ts'

function offline(keyPrefix?: string): HfBucketsAccessor {
  return new HfBucketsAccessor(
    keyPrefix === undefined
      ? { bucket: 'o/b', endpoint: DEAD_ENDPOINT }
      : { bucket: 'o/b', endpoint: DEAD_ENDPOINT, keyPrefix },
  )
}

describe('bucket urls', () => {
  it('carries no revision', () => {
    // `/paths-info/main` is 404 on a bucket (measured 2026-09-25).
    expect(pathsInfoUrl(offline())).toBe(`${DEAD_ENDPOINT}/api/buckets/o/b/paths-info`)
    expect(resolveUrl(offline(), 'a.txt')).toBe(`${DEAD_ENDPOINT}/buckets/o/b/resolve/a.txt`)
  })

  it('encodes each segment', () => {
    // An unencoded "#" truncates the URL at the fragment. Parens stay raw, as
    // hf_hub's resolveUrl leaves them; the Hub accepts both spellings.
    expect(resolveUrl(offline(), 'dir/Inkling_o (1)#.png')).toBe(
      `${DEAD_ENDPOINT}/buckets/o/b/resolve/dir/Inkling_o%20(1)%23.png`,
    )
  })

  it.each(['pfx/', '/pfx/', 'pfx'])('applies the key prefix %s once', (keyPrefix) => {
    expect(resolveUrl(offline(keyPrefix), '/a.txt').endsWith('/resolve/pfx/a.txt')).toBe(true)
  })

  it('does not double a trailing-slash endpoint', () => {
    const accessor = new HfBucketsAccessor({ bucket: 'o/b', endpoint: 'http://127.0.0.1:9/' })
    expect(pathsInfoUrl(accessor)).toBe('http://127.0.0.1:9/api/buckets/o/b/paths-info')
    expect(resolveUrl(accessor, 'a.txt')).toBe('http://127.0.0.1:9/buckets/o/b/resolve/a.txt')
  })
})

const FILE = { type: 'file', path: 'pfx/a.txt', size: 1, xetHash: 'h' }
const DIR = { type: 'directory', path: 'pfx/a.txt' }

async function answering(answer: unknown): Promise<[HfBucketsAccessor, FakeHub]> {
  const accessor = new HfBucketsAccessor({ bucket: 'o/b', keyPrefix: 'pfx/' })
  const hub = await installFakeOperator(accessor, fakeHfOperator({}))
  hub.bucketAnswer = answer
  return [accessor, hub]
}

describe('fetchRow', () => {
  it.each([
    [[], null],
    [[FILE], FILE],
    [[DIR], null],
    [[DIR, FILE], FILE],
  ])('answers the asked file row (%j)', async (answer, expected) => {
    const [accessor, hub] = await answering(answer)
    expect(await fetchRow(accessor, 'a.txt')).toEqual(expected)
    // The prefix rides the asked path, not the route.
    expect(hub.posts.map((p) => JSON.parse(p.body) as unknown)).toEqual([{ paths: ['pfx/a.txt'] }])
  })

  it.each([[[{ ...FILE, path: 'pfx/other.txt' }]], [{ x: 1 }]])(
    'refuses an answer about something else (%j)',
    async (answer) => {
      // An empty list is the only answer that means "absent"; anything else
      // read as absence would let reconcile delete a file that exists.
      const [accessor] = await answering(answer)
      await expect(fetchRow(accessor, 'a.txt')).rejects.toBeInstanceOf(HfHubError)
    },
  )

  it('never asks about the mount root', async () => {
    const [accessor, hub] = await answering([FILE])
    expect(await fetchRow(accessor, '')).toBeNull()
    expect(hub.posts).toEqual([])
  })
})

describe('readToken', () => {
  it.each([
    ['"X"', 'X'],
    ['X', 'X'],
    ['W/"X"', null],
    ['""', null],
    ['', null],
  ])('reads %s as %s', (raw, token) => {
    expect(readToken(raw)).toBe(token)
  })
})

describe('token plumbing', () => {
  it.each([
    ['tok', 'Bearer tok'],
    [undefined, ''],
  ])('sends token %s to both bucket routes', async (token, sent) => {
    // opendal used to carry the credential; now both HTTP calls must.
    const accessor = new HfBucketsAccessor(
      token === undefined ? { bucket: 'o/b' } : { bucket: 'o/b', token },
    )
    const hub = await installFakeOperator(accessor, fakeHfOperator({ 'a.txt': 'x' }))
    expect(await fetchRow(accessor, 'a.txt')).not.toBeNull()
    await read(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(hub.auth.get('bucket_paths_info')).toEqual([sent])
    expect(hub.auth.get('bucket_resolve')).toEqual([sent])
  })
})

describe('the fake bucket wire', () => {
  it('matches the live hub', async () => {
    // Each assertion is a shape measured against huggingface.co on 2026-09-25;
    // a fake that drifted from any of them would let the suite pass against a
    // Hub that does not exist.
    const data = Buffer.from('abc')
    const hub = new FakeHub()
    hub.xet = false
    const files = hub.files('buckets', 'o/b')
    files.set('a.txt', data)
    files.set('d/x.txt', Buffer.from('x'))
    files.set('w.txt', Buffer.from('w'))
    files.set('n.txt', Buffer.from('n'))
    hub.etags.set('w.txt', 'W/"weak"')
    hub.etags.set('n.txt', NO_ETAG)
    await serveHub(hub)
    try {
      const api = `${hub.url}/api/buckets/o/b/paths-info`
      const res = `${hub.url}/buckets/o/b/resolve`
      const text = await fetch(api, { method: 'POST', body: '{"paths":["a.txt"]}' })
      expect(text.status).toBe(400)
      expect(((await text.json()) as { error: string }).error).toBe(INVALID_PATHS)
      const rows = (await (
        await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: ['a.txt', '/a.txt', 'd', 'd/'] }),
        })
      ).json()) as Record<string, unknown>[]
      expect(rows).toEqual([
        {
          type: 'file',
          path: 'a.txt',
          size: 3,
          xetHash: xetHash(data),
          uploadedAt: rows[0]?.uploadedAt,
        },
      ])
      expect(rows[0]?.xetHash).not.toBe(lfsOid(data))
      const whole = await fetch(`${res}/a.txt`, { headers: { Authorization: 'Bearer tok' } })
      expect(whole.headers.get('etag')).toBe(`"${xetHash(data)}"`)
      expect(Buffer.from(await whole.arrayBuffer())).toEqual(data)
      const ranged = await fetch(`${res}/a.txt`, { headers: { Range: 'bytes=1-1' } })
      await ranged.arrayBuffer()
      expect([ranged.status, ranged.headers.get('etag')]).toEqual([206, `"${xetHash(data)}"`])
      const past = await fetch(`${res}/a.txt`, { headers: { Range: 'bytes=3-9' } })
      await past.arrayBuffer()
      expect([past.status, past.headers.get('etag')]).toEqual([416, null])
      const missing = await fetch(`${res}/nope.txt`)
      await missing.arrayBuffer()
      expect([missing.status, missing.headers.get('x-error-code')]).toEqual([404, 'EntryNotFound'])
      const weak = await fetch(`${res}/w.txt`)
      await weak.arrayBuffer()
      expect(weak.headers.get('etag')).toBe('W/"weak"')
      const none = await fetch(`${res}/n.txt`)
      await none.arrayBuffer()
      expect(none.headers.get('etag')).toBeNull()
    } finally {
      await hub.close()
    }
    expect(hub.auth.get('bucket_resolve')?.[0]).toBe('Bearer tok')
    expect(hub.statuses).toContainEqual(['bucket_cdn', 416])
  })
})

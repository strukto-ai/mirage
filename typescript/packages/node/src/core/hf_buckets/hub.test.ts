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
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { HfHubError } from '@struktoai/mirage-core/core/hf_hub/client'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket, PATHS_INFO, RESOLVE } from '../../../tests/fixtures/hf_bucket.ts'
import { fetchRow, pathsInfoUrl, readToken, resolveUrl } from './hub.ts'
import { read } from './read.ts'

// Nothing listens here: the URL tests build no request.
const DEAD = 'http://127.0.0.1:9'
const INVALID_PATHS = '✖ Invalid input\n  → at paths'

let origin = ''
const buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  await Promise.all(buckets.splice(0).map((bucket) => bucket.close()))
})

async function made(account?: string): Promise<HfBucket> {
  const bucket = new HfBucket(origin, account)
  buckets.push(bucket)
  await bucket.reset()
  return bucket
}

function offline(keyPrefix?: string): HfBucketsAccessor {
  return new HfBucketsAccessor(
    keyPrefix === undefined
      ? { bucket: 'o/b', endpoint: DEAD }
      : { bucket: 'o/b', endpoint: DEAD, keyPrefix },
  )
}

describe('bucket urls', () => {
  it('carries no revision', () => {
    // `/paths-info/main` is 404 on a bucket (measured 2026-09-25).
    expect(pathsInfoUrl(offline())).toBe(`${DEAD}/api/buckets/o/b/paths-info`)
    expect(resolveUrl(offline(), 'a.txt')).toBe(`${DEAD}/buckets/o/b/resolve/a.txt`)
  })

  it('encodes each segment', () => {
    // An unencoded "#" truncates the URL at the fragment. Parens stay raw, as
    // hf_hub's resolveUrl leaves them; the Hub accepts both spellings.
    expect(resolveUrl(offline(), 'dir/Inkling_o (1)#.png')).toBe(
      `${DEAD}/buckets/o/b/resolve/dir/Inkling_o%20(1)%23.png`,
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

// An accessor under `pfx/` whose next paths-info is answered with `answer`.
async function answering(answer: unknown): Promise<[HfBucketsAccessor, HfBucket]> {
  const bucket = await made()
  await bucket.run.recordRequests()
  await bucket.run.answerNext('POST', PATHS_INFO, 200, answer as never)
  return [bucket.accessor('pfx/'), bucket]
}

describe('fetchRow', () => {
  it.each([
    [[], null],
    [[FILE], FILE],
    [[DIR], null],
    [[DIR, FILE], FILE],
  ])('answers the asked file row (%j)', async (answer, expected) => {
    const [accessor, bucket] = await answering(answer)
    expect(await fetchRow(accessor, 'a.txt')).toEqual(expected)
    // The prefix rides the asked path, not the route.
    expect(await bucket.run.bodies('POST', PATHS_INFO)).toEqual([{ paths: ['pfx/a.txt'] }])
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
    const [accessor, bucket] = await answering([FILE])
    expect(await fetchRow(accessor, '')).toBeNull()
    expect(await bucket.count('paths_info')).toBe(0)
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
    [undefined, undefined],
  ])('sends token %s to both bucket routes', async (token, sent) => {
    // opendal used to carry the credential; now both HTTP calls must. A
    // caller that sends no token reaches the anonymous default account.
    const bucket = await made(token ?? 'default')
    await bucket.put({ 'a.txt': 'x' })
    await bucket.run.recordRequests('authorization')
    const accessor = bucket.accessor(undefined, token ?? null)
    expect(await fetchRow(accessor, 'a.txt')).not.toBeNull()
    await read(accessor, PathSpec.fromStrPath('/a.txt'))
    const want = [sent === undefined ? {} : { authorization: sent }]
    expect(await bucket.run.headers('POST', PATHS_INFO)).toEqual(want)
    expect(await bucket.run.headers('GET', RESOLVE)).toEqual(want)
  })
})

describe('the fake bucket wire', () => {
  it('matches the live hub', async () => {
    // Each assertion is a shape measured against huggingface.co on 2026-09-25;
    // a fake that drifted from any of them would let the suite pass against a
    // Hub that does not exist.
    const bucket = await made()
    await bucket.put({ 'a.txt': 'abc', 'd/x.txt': 'x' })
    const auth = { Authorization: `Bearer ${bucket.token}` }
    const api = `${origin}/api/buckets/o/b/paths-info`
    const res = `${origin}/buckets/o/b/resolve`
    const text = await fetch(api, { method: 'POST', headers: auth, body: '{"paths":["a.txt"]}' })
    expect(text.status).toBe(400)
    expect(((await text.json()) as { error: string }).error).toBe(INVALID_PATHS)
    const rows = (await (
      await fetch(api, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['a.txt', '/a.txt', 'd', 'd/'] }),
      })
    ).json()) as Record<string, unknown>[]
    const hash = String(rows[0]?.xetHash)
    expect(rows).toEqual([
      { type: 'file', path: 'a.txt', size: 3, xetHash: hash, uploadedAt: rows[0]?.uploadedAt },
    ])
    const whole = await fetch(`${res}/a.txt`, { headers: auth })
    expect(whole.headers.get('etag')).toBe(`"${hash}"`)
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe('abc')
    const ranged = await fetch(`${res}/a.txt`, { headers: { ...auth, Range: 'bytes=1-1' } })
    await ranged.arrayBuffer()
    expect([ranged.status, ranged.headers.get('etag')]).toEqual([206, `"${hash}"`])
    const past = await fetch(`${res}/a.txt`, { headers: { ...auth, Range: 'bytes=3-9' } })
    await past.arrayBuffer()
    expect([past.status, past.headers.get('etag')]).toEqual([416, null])
    const missing = await fetch(`${res}/nope.txt`, { headers: auth })
    await missing.arrayBuffer()
    expect([missing.status, missing.headers.get('x-error-code')]).toEqual([404, 'EntryNotFound'])
  })
})

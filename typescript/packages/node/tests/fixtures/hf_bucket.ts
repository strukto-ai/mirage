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

import { randomUUID } from 'node:crypto'
import { type Entry, Operator } from 'opendal'
import { HfBucketsAccessor } from '../../src/accessor/hf_buckets.ts'
import { KitRun } from '../../../core/tests/fixtures/kit_fake.ts'

export const BUCKET = 'o/b'
// The run the fake's Xet storage lives in. Content addressed by hash is
// global on the Hub, and a client that uploaded content once commits it
// again without re-uploading, so the storage is shared and never dropped;
// each bucket is an account of its own in it.
const SHARED_RUN = 'default'
export const TREE = '/api/buckets/:ns/:name/tree/*path'
export const PATHS_INFO = '/api/buckets/:ns/:name/paths-info'
export const RESOLVE = '/buckets/:ns/:name/resolve/*path'
export const CDN = '/cdn/:ns/:name/:hash'
const XET_READ_TOKEN = '/api/buckets/:ns/:name/xet-read-token'
export const UNTIL_CLEARED = 1_000_000

/** One request as the tests read it: its name, path and query. */
export type Logged = [string, string, string]

function bound(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key, target)
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value
}

function withoutSize(entry: Entry): Entry {
  const meta = entry.metadata()
  const bare = new Proxy(meta, {
    get: (target, key) => (key === 'contentLength' ? null : bound(target, key)),
  })
  return new Proxy(entry, {
    get: (target, key) => (key === 'metadata' ? () => bare : bound(target, key)),
  })
}

/**
 * Make `op`'s listings name `key` with a null size.
 *
 * The node binding types a listed size as possibly null, but a Hub page
 * without one reads as 0 through it (probed), so the null is staged on the
 * real entry; both hosts keep the stat that fills it. Twin of Python's
 * ListedBare.
 */
export function listedWithoutSize(op: Operator, key: string): void {
  const list = op.list.bind(op)
  Object.defineProperty(op, 'list', {
    value: async (...args: Parameters<Operator['list']>): Promise<Entry[]> =>
      (await list(...args)).map((entry) => (entry.path() === key ? withoutSize(entry) : entry)),
  })
}

interface Listed {
  method: string
  route: string
  path: string
  query: string
  body: unknown
}

/** A bucket file's paths-info row, as the Hub answers it. */
export interface BucketRow {
  type: string
  path: string
  size: number
  xetHash: string
  uploadedAt: string
}

/**
 * One Hugging Face bucket on the integ `hf` fake, and the writes a test
 * arranges it by. Twin of python/tests/fixtures/hf_bucket.py.
 *
 * The account is the access token, so each bucket sends a token of its own.
 * Another client's writes go through opendal, the client the Hub's Xet
 * uploads are made with.
 */
export class HfBucket {
  readonly token: string
  readonly run: KitRun

  /**
   * @param origin the fake's origin.
   * @param account the account, a fresh one when left out; `default` is the
   *   one a caller that sends no token reaches.
   */
  constructor(
    readonly origin: string,
    account?: string,
  ) {
    this.token = account ?? `unit-${randomUUID().replaceAll('-', '')}`
    this.run = new KitRun(origin, { Authorization: `Bearer ${this.token}` }, SHARED_RUN)
  }

  /** A mount config's fields for the bucket, as `buildVfs` takes them. */
  fields(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { bucket: BUCKET, endpoint: this.origin, token: this.token, ...extra }
  }

  /**
   * A Mirage accessor on the bucket.
   *
   * @param keyPrefix the mount's key prefix.
   * @param token the access token; the bucket's own when left out, none when null.
   */
  accessor(keyPrefix?: string, token?: string | null): HfBucketsAccessor {
    const sent = token === undefined ? this.token : token
    return new HfBucketsAccessor({
      bucket: BUCKET,
      endpoint: this.origin,
      ...(sent === null ? {} : { token: sent }),
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
    } as ConstructorParameters<typeof HfBucketsAccessor>[0])
  }

  /** An opendal operator on the whole bucket, another client. */
  operator(): Operator {
    return new Operator('hf', {
      repo_type: 'bucket',
      repo_id: BUCKET,
      token: this.token,
      endpoint: this.origin,
    })
  }

  /** Empty the bucket's account; the Xet storage stays. */
  async reset(): Promise<void> {
    await this.run.call('POST', '/reset', { json: { tenants: [this.token] } })
  }

  /** Write files, bucket-absolute keys, as another client would. */
  async put(files: Record<string, string | Uint8Array>): Promise<void> {
    const op = this.operator()
    for (const [key, data] of Object.entries(files)) {
      await op.write(key, typeof data === 'string' ? Buffer.from(data) : Buffer.from(data))
    }
  }

  /** Delete a file as another client would. */
  async remove(key: string): Promise<void> {
    await this.operator().delete(key)
  }

  /** Every file the bucket holds, bucket-absolute key to content. */
  async files(): Promise<Record<string, string>> {
    const op = this.operator()
    const out: Record<string, string> = {}
    for (const entry of await op.list('', { recursive: true })) {
      const path = entry.path()
      if (!path.endsWith('/')) out[path] = (await op.read(path)).toString()
    }
    return out
  }

  /** The paths-info row the Hub answers for a file. */
  async row(key: string): Promise<BucketRow> {
    const rows = await this.run.call<BucketRow[]>('POST', `/api/buckets/${BUCKET}/paths-info`, {
      json: { paths: [key] },
    })
    const [only] = rows
    if (rows.length !== 1 || only === undefined) throw new Error(`no one row for ${key}`)
    return only
  }

  /**
   * Answer the next `times` requests `log` names `name` with the Hub's error
   * for `status`, carrying `code` as its `X-Error-Code` when one is given.
   */
  async refuse(name: string, status: number, code = '', times = UNTIL_CLEARED): Promise<void> {
    const at: Record<string, [string, string]> = {
      paths_info: ['POST', PATHS_INFO],
      resolve: ['GET', RESOLVE],
      tree: ['GET', TREE],
    }
    const [method, route] = at[name] ?? ['', '']
    const message = `fake ${name} refused`
    const headers: Record<string, string> = { 'X-Error-Message': message }
    if (code !== '') headers['X-Error-Code'] = code
    await this.run.answerNext(
      method,
      route,
      status,
      { error: message },
      times,
      undefined,
      undefined,
      0,
      headers,
    )
  }

  /** Answer the next download of the bytes with `etag` as their ETag, or with none. */
  async serveEtag(data: string | Uint8Array, etag: string | null): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
    if (etag !== null) headers.ETag = etag
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.run.answerNext('GET', CDN, 200, body, 1, undefined, undefined, 0, headers)
  }

  /**
   * Each request since recording started, as `[name, path, query]`: `tree`,
   * `paths_info`, `stat` (a HEAD on resolve), `resolve`, `cdn` and
   * `opendal_read` (Xet's read token and reconstructions, how opendal reads);
   * `path` is the key a resolve names. Any other request is named by its
   * method and route.
   */
  async log(): Promise<Logged[]> {
    const listed = await this.run.call<{ requests: Listed[] }>('GET', '/_kit/requests')
    return listed.requests.map((r): Logged => {
      const path = decodeURIComponent(r.path)
      if (r.route === RESOLVE) {
        return [r.method === 'HEAD' ? 'stat' : 'resolve', path.split('/resolve/')[1] ?? '', r.query]
      }
      if (r.route === TREE) return ['tree', path.split('/tree/')[1] ?? '', r.query]
      if (r.route === PATHS_INFO) return ['paths_info', JSON.stringify(r.body), r.query]
      if (r.route === CDN) return ['cdn', '', r.query]
      if (r.route === XET_READ_TOKEN || r.route.includes('reconstructions')) {
        return ['opendal_read', path, r.query]
      }
      return [`${r.method} ${r.route}`, path, r.query]
    })
  }

  /** How many requests `log` names `name` since recording started. */
  async count(name: string): Promise<number> {
    return (await this.log()).filter(([logged]) => logged === name).length
  }

  /** Empty the account and close the run's session, keeping the run. */
  async close(): Promise<void> {
    await this.reset()
    await this.run.close(false)
  }
}

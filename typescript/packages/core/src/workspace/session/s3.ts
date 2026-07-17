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

import {
  createS3Client,
  isNotFoundError,
  loadS3Module,
  streamToBuffer,
  type S3SendClient,
} from '../../core/s3/_client.ts'
import { normalizeKeyPrefix, type S3Config } from '../../resource/s3/config.ts'
import { SessionStore, generationOf, type SessionFields } from './store.ts'

/**
 * True when a conditional write lost: the object changed since the
 * compare-read (412) or a concurrent conditional write is in flight
 * (409). Mirrors the Python `_is_condition_lost`.
 */
export function isConditionLostError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict') return true
  const status = e.$metadata?.httpStatusCode
  return status === 412 || status === 409
}

const decoder = new TextDecoder()

/**
 * One JSON-record-per-object client with ETag-anchored CAS.
 *
 * The generic building block both S3 stores share (mirroring how the
 * Redis stores share one cas.lua): a record is one object at
 * `{prefix}{name}.json`, and a conditional write anchors on the exact
 * ETag the compare-read returned, so the generation check and the
 * write hit the same stored version. Immutable-blob planes never need
 * this; it exists only for the few mutable control-plane cells.
 * Mirrors the Python S3RecordClient.
 */
export class S3RecordClient {
  private readonly config: S3Config
  private readonly prefix: string
  private clientPromise: Promise<S3SendClient> | null = null

  constructor(config: S3Config, prefix: string) {
    this.config = config
    this.prefix = prefix
  }

  private client(): Promise<S3SendClient> {
    this.clientPromise ??= createS3Client(this.config) as unknown as Promise<S3SendClient>
    return this.clientPromise
  }

  key(name: string): string {
    return `${this.prefix}${name}.json`
  }

  /** Read one record; `[fields, etag]`, `[null, '']` when absent. */
  async get(name: string): Promise<[Record<string, unknown> | null, string]> {
    const [client, mod] = await Promise.all([this.client(), loadS3Module(this.config)])
    let response: Record<string, unknown>
    try {
      response = await client.send(
        new mod.GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(name) }),
      )
    } catch (err) {
      if (isNotFoundError(err)) return [null, '']
      throw err
    }
    const body = await streamToBuffer(response.Body)
    const etag = typeof response.ETag === 'string' ? response.ETag : ''
    return [JSON.parse(decoder.decode(body)) as Record<string, unknown>, etag]
  }

  async put(name: string, fields: Record<string, unknown>): Promise<void> {
    const [client, mod] = await Promise.all([this.client(), loadS3Module(this.config)])
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(name),
        Body: JSON.stringify(fields),
      }),
    )
  }

  /**
   * Write one record iff its stored generation matches.
   *
   * Compare-read the record, check the generation client-side, then
   * make the write conditional on the exact version read: If-None-Match
   * for create (expected 0, nothing stored), If-Match on the read ETag
   * otherwise. A 412/409 means another writer moved the record between
   * our read and write; the caller adopts and retries.
   */
  async casPut(
    name: string,
    fields: Record<string, unknown>,
    expectedGeneration: number,
  ): Promise<boolean> {
    const [stored, etag] = await this.get(name)
    if (generationOf(stored) !== expectedGeneration) return false
    const [client, mod] = await Promise.all([this.client(), loadS3Module(this.config)])
    const condition = stored === null ? { IfNoneMatch: '*' } : { IfMatch: etag }
    try {
      await client.send(
        new mod.PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.key(name),
          Body: JSON.stringify(fields),
          ...condition,
        }),
      )
    } catch (err) {
      if (isConditionLostError(err)) return false
      throw err
    }
    return true
  }

  async listNames(): Promise<string[]> {
    const [client, mod] = await Promise.all([this.client(), loadS3Module(this.config)])
    const names: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await client.send(
        new mod.ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.prefix,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }),
      )
      const contents = (response.Contents ?? []) as { Key: string }[]
      for (const entry of contents) {
        const key = entry.Key.slice(this.prefix.length)
        if (key.endsWith('.json')) names.push(key.slice(0, -'.json'.length))
      }
      continuationToken =
        response.IsTruncated === true ? (response.NextContinuationToken as string) : undefined
    } while (continuationToken !== undefined)
    return names
  }

  /** Every stored record, keyed by name; batch-first (one list, then parallel reads). */
  async loadAll(): Promise<Map<string, Record<string, unknown>>> {
    const names = await this.listNames()
    const records = await Promise.all(names.map((name) => this.get(name)))
    const out = new Map<string, Record<string, unknown>>()
    for (const [i, name] of names.entries()) {
      const record = records[i]
      if (record === undefined) continue
      const [fields] = record
      if (fields !== null) out.set(name, fields)
    }
    return out
  }

  async delete(names: readonly string[]): Promise<void> {
    if (names.length === 0) return
    const [client, mod] = await Promise.all([this.client(), loadS3Module(this.config)])
    await client.send(
      new mod.DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: names.map((name) => ({ Key: this.key(name) })) },
      }),
    )
  }

  async clear(): Promise<void> {
    await this.delete(await this.listNames())
  }

  async close(): Promise<void> {
    if (this.clientPromise !== null) {
      const client = await this.clientPromise
      client.destroy?.()
      this.clientPromise = null
    }
  }
}

/**
 * SessionStore backed by per-session S3 objects.
 *
 * One object per session at `{keyPrefix}sessions/{session_id}.json`
 * (the store appends the `sessions/` segment, mirroring the Redis
 * store's `{keyPrefix}sessions` hash). Conditional writes (If-Match
 * on the compare-read's ETag) give the same generation-CAS contract
 * as the Redis Lua script, so the S3 control plane is safe for the
 * same multi-process sharing. Works on any S3-compatible backend that
 * honors conditional PUTs. Mirrors the Python S3SessionStore.
 */
export class S3SessionStore extends SessionStore {
  private readonly records: S3RecordClient

  constructor(config: S3Config) {
    super()
    const prefix = normalizeKeyPrefix(config.keyPrefix) ?? ''
    this.records = new S3RecordClient(config, `${prefix}sessions/`)
  }

  async load(): Promise<Map<string, SessionFields>> {
    return this.records.loadAll()
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    await this.records.put(sessionId, fields)
  }

  async casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return this.records.casPut(sessionId, fields, expectedGeneration)
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    await this.records.delete(sessionIds)
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const names = await this.records.listNames()
    const stale = names.filter((name) => !entries.has(name))
    await this.records.delete(stale)
    await Promise.all(
      [...entries].map(([sessionId, fields]) => this.records.put(sessionId, fields)),
    )
  }

  async clear(): Promise<void> {
    await this.records.clear()
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}

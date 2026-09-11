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

import { escapeGlob } from '@struktoai/mirage-core/core/redis/utils'
import type { RedisRestore, RedisStoreLike } from '@struktoai/mirage-core/resource/redis/store'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { RedisClientType } from 'redis'
import { loadOptionalPeer } from '../../optional_peer.ts'

export interface RedisStoreOptions {
  url?: string
  client?: RedisClientType
  keyPrefix?: string
}

export class RedisStore implements RedisStoreLike {
  readonly url: string
  readonly keyPrefix: string
  private readonly providedClient: RedisClientType | null
  private clientPromise: Promise<RedisClientType> | null = null

  constructor(options: RedisStoreOptions = {}) {
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.keyPrefix = options.keyPrefix ?? 'mirage:fs:'
    this.providedClient = options.client ?? null
  }

  fk(path: string): string {
    return `${this.keyPrefix}file:${path}`
  }

  dk(): string {
    return `${this.keyPrefix}dir`
  }

  mk(path: string): string {
    return `${this.keyPrefix}modified:${path}`
  }

  ak(path: string): string {
    return `${this.keyPrefix}attrs:${path}`
  }

  async client(): Promise<RedisClientType> {
    if (this.providedClient !== null) return this.providedClient
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisResource / RedisFileCacheStore', packageName: 'redis' },
      )
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      } as Parameters<typeof mod.createClient>[0])
      await c.connect()
      await c.sAdd(this.dk(), '/')
      return c
    })()
    return this.clientPromise
  }

  async open(): Promise<void> {
    await this.client()
  }

  async getFile(path: string): Promise<Uint8Array | null> {
    const c = await this.client()
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        get: (k: string) => Promise<Buffer | null>
      }
    }
    const mod = (await import('redis')) as unknown as {
      RESP_TYPES: { readonly BLOB_STRING: number }
    }
    const blob = mod.RESP_TYPES.BLOB_STRING
    const mapping: Record<number, unknown> = { [blob]: Buffer }
    const raw = await typed.withTypeMapping(mapping).get(this.fk(path))
    if (raw === null) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  /**
   * A byte window of a stored file, or null when the key is absent.
   *
   * `GETRANGE` slices server-side, so a window costs the window rather than
   * the whole value on the wire. Its bounds are inclusive and `-1` means the
   * last byte, which is how "to the end" is spelled.
   *
   * `EXISTS` rides along because `GETRANGE` answers an empty string for a
   * missing key, for an empty file and for a window past the end alike;
   * without it a read of a deleted path would return an empty buffer instead
   * of throwing. The two are issued together rather than through `MULTI`,
   * which drops the Buffer type mapping and hands back a lossy string:
   * node-redis pipelines commands issued in the same tick, so this is still
   * one round trip.
   *
   * @param path mount-relative path of the file
   * @param offset first byte to read
   * @param size how many bytes, or null for the rest
   */
  async getFileRange(
    path: string,
    offset: number,
    size: number | null,
  ): Promise<Uint8Array | null> {
    const c = await this.client()
    const key = this.fk(path)
    // GETRANGE 0 -1 means the whole value, not an empty window.
    if (size === 0) return (await c.exists(key)) === 0 ? null : new Uint8Array(0)
    const mod = (await import('redis')) as unknown as {
      RESP_TYPES: { readonly BLOB_STRING: number }
    }
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        getRange: (k: string, s: number, e: number) => Promise<Buffer>
      }
      exists: (k: string) => Promise<number>
    }
    const mapping: Record<number, unknown> = { [mod.RESP_TYPES.BLOB_STRING]: Buffer }
    const end = size === null ? -1 : offset + size - 1
    const [exists, raw] = await Promise.all([
      typed.exists(key),
      typed.withTypeMapping(mapping).getRange(key, offset, end),
    ])
    if (exists === 0) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  async setFile(path: string, data: Uint8Array): Promise<void> {
    const c = await this.client()
    await c.set(this.fk(path), Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  async delFile(path: string): Promise<void> {
    const c = await this.client()
    await c.del(this.fk(path))
  }

  async hasFile(path: string): Promise<boolean> {
    const c = await this.client()
    return (await c.exists(this.fk(path))) > 0
  }

  async listFiles(prefix = ''): Promise<string[]> {
    const c = await this.client()
    const pattern = `${escapeGlob(`${this.keyPrefix}file:${prefix}`)}*`
    const strip = `${this.keyPrefix}file:`.length
    const result: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      const keys = Array.isArray(k) ? k : [k]
      for (const key of keys) result.push(key.slice(strip))
    }
    return result.sort(compareCodePoints)
  }

  async fileLen(path: string): Promise<number> {
    const c = await this.client()
    return c.strLen(this.fk(path))
  }

  async hasDir(path: string): Promise<boolean> {
    const c = await this.client()
    return (await c.sIsMember(this.dk(), path)) === 1
  }

  async addDir(path: string): Promise<void> {
    const c = await this.client()
    await c.sAdd(this.dk(), path)
  }

  async removeDir(path: string): Promise<void> {
    const c = await this.client()
    await c.sRem(this.dk(), path)
  }

  async listDirs(): Promise<Set<string>> {
    const c = await this.client()
    const members = await c.sMembers(this.dk())
    return new Set(members)
  }

  async getModified(path: string): Promise<string | null> {
    const c = await this.client()
    return c.get(this.mk(path))
  }

  async setModified(path: string, ts: string): Promise<void> {
    const c = await this.client()
    await c.set(this.mk(path), ts)
  }

  async delModified(path: string): Promise<void> {
    const c = await this.client()
    await c.del(this.mk(path))
  }

  async getAttrs(path: string): Promise<Record<string, string>> {
    const c = await this.client()
    const raw = await c.hGetAll(this.ak(path))
    return { ...raw }
  }

  async setAttrs(path: string, fields: Record<string, string>): Promise<void> {
    const c = await this.client()
    await c.hSet(this.ak(path), fields)
  }

  async delAttrs(path: string): Promise<void> {
    const c = await this.client()
    await c.del(this.ak(path))
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const c = await this.client()
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      if (Array.isArray(k)) keys.push(...k)
      else keys.push(k)
    }
    return keys
  }

  async listAttrs(): Promise<Record<string, Record<string, string>>> {
    const c = await this.client()
    const head = `${this.keyPrefix}attrs:`
    const out: Record<string, Record<string, string>> = {}
    for (const key of await this.scanKeys(`${escapeGlob(head)}*`)) {
      out[key.slice(head.length)] = { ...(await c.hGetAll(key)) }
    }
    return out
  }

  async listModified(): Promise<Record<string, string>> {
    const c = await this.client()
    const head = `${this.keyPrefix}modified:`
    const out: Record<string, string> = {}
    for (const key of await this.scanKeys(`${escapeGlob(head)}*`)) {
      const val = await c.get(key)
      if (val !== null) out[key.slice(head.length)] = val
    }
    return out
  }

  async restore(state: RedisRestore): Promise<void> {
    const c = await this.client()
    const pipe = c.multi()
    for (const [path, data] of Object.entries(state.files)) {
      pipe.set(this.fk(path), Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    }
    for (const dir of state.dirs) pipe.sAdd(this.dk(), dir)
    for (const [path, fields] of Object.entries(state.attrs)) {
      if (Object.keys(fields).length > 0) pipe.hSet(this.ak(path), fields)
    }
    for (const [path, ts] of Object.entries(state.modified)) pipe.set(this.mk(path), ts)
    await pipe.exec()
  }

  async clear(): Promise<void> {
    const c = await this.client()
    const p = escapeGlob(this.keyPrefix)
    for (const pattern of [`${p}file:*`, `${p}tmp:*`, `${p}modified:*`, `${p}attrs:*`]) {
      const keys = await this.scanKeys(pattern)
      if (keys.length > 0) await c.del(keys)
    }
    await c.del(this.dk())
  }

  async close(): Promise<void> {
    if (this.providedClient !== null) return
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    const typed = c as unknown as { destroy?: () => void }
    if (typeof typed.destroy === 'function') typed.destroy()
    else if (c.isOpen) await c.quit()
    this.clientPromise = null
  }
}

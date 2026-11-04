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

import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { RedisRestore, RedisStoreLike } from '@struktoai/mirage-core/vfs/redis/store'
import { TRUNCATE_SCRIPT } from '@struktoai/mirage-core/vfs/redis/constants'
import { escapeGlob } from '@struktoai/mirage-core/vfs/redis/store'
import { RespClient, RespError, type Connect, type RespArg, type RespReply } from './resp.ts'

export interface RedisStoreOptions {
  url?: string
  keyPrefix?: string
  /** The host's TCP API; on Cloudflare, `connect` from `cloudflare:sockets`. */
  connect: Connect
}

const SCAN_COUNT = 1000
// A DEL names at most this many keys, so one command stays small.
const KEY_BATCH = 500
const DECODER = new TextDecoder()

function text(reply: RespReply): string | null {
  if (reply === null) return null
  if (reply instanceof Uint8Array) return DECODER.decode(reply)
  return String(reply)
}

function bytes(reply: RespReply): Uint8Array | null {
  if (reply === null) return null
  if (reply instanceof Uint8Array) return reply
  return new TextEncoder().encode(String(reply))
}

function list(reply: RespReply): RespReply[] {
  return Array.isArray(reply) ? reply : []
}

// HGETALL's flat field, value, field, value as a record.
function record(reply: RespReply): Record<string, string> {
  const flat = list(reply)
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[text(flat[i] ?? null) ?? ''] = text(flat[i + 1] ?? null) ?? ''
  }
  return out
}

function checked(replies: readonly RespReply[]): RespReply[] {
  for (const reply of replies) if (reply instanceof RespError) throw reply
  return [...replies]
}

/**
 * The redis keyspace a mount is built on, over a host's TCP API.
 *
 * The key layout is node's and python's, so the three runtimes pointed at
 * one server serve one filesystem: `<prefix>file:<path>` holds the bytes,
 * `<prefix>dir` is the set of every directory, `<prefix>modified:<path>`
 * the ISO mtime and `<prefix>attrs:<path>` a hash carrying the stat overlay.
 */
export class RedisStore implements RedisStoreLike {
  readonly url: string
  readonly keyPrefix: string
  private readonly client: RespClient
  private seeded: Promise<void> | null = null

  constructor(options: RedisStoreOptions) {
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.keyPrefix = options.keyPrefix ?? 'mirage:fs:'
    this.client = new RespClient(this.url, options.connect)
  }

  private fk(path: string): string {
    return `${this.keyPrefix}file:${path}`
  }

  private dk(): string {
    return `${this.keyPrefix}dir`
  }

  private mk(path: string): string {
    return `${this.keyPrefix}modified:${path}`
  }

  private ak(path: string): string {
    return `${this.keyPrefix}attrs:${path}`
  }

  // The root is a member of the directory set, as node's store makes it.
  private async ready(): Promise<RespClient> {
    this.seeded ??= this.client.call('SADD', this.dk(), '/').then(
      () => undefined,
      (err: unknown) => {
        this.seeded = null
        throw err
      },
    )
    await this.seeded
    return this.client
  }

  private async call(...args: RespArg[]): Promise<RespReply> {
    return (await this.ready()).call(...args)
  }

  private async pipeline(commands: readonly (readonly RespArg[])[]): Promise<RespReply[]> {
    return checked(await (await this.ready()).pipeline(commands))
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = list(
        await this.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT),
      )
      cursor = text(next ?? null) ?? '0'
      for (const key of list(batch ?? null)) keys.push(text(key) ?? '')
    } while (cursor !== '0')
    return keys
  }

  async getFile(path: string): Promise<Uint8Array | null> {
    return bytes(await this.call('GET', this.fk(path)))
  }

  /**
   * A byte window of a stored file, or null when the key is absent.
   * `GETRANGE` answers an empty string for a missing key, an empty file and
   * a window past the end alike, so `EXISTS` rides in the same round trip.
   */
  async getFileRange(
    path: string,
    offset: number,
    size: number | null,
  ): Promise<Uint8Array | null> {
    const key = this.fk(path)
    // GETRANGE 0 -1 means the whole value, not an empty window.
    if (size === 0) return Number(await this.call('EXISTS', key)) === 0 ? null : new Uint8Array(0)
    const end = size === null ? -1 : offset + size - 1
    const [exists, window] = await this.pipeline([
      ['EXISTS', key],
      ['GETRANGE', key, offset, end],
    ])
    if (Number(exists) === 0) return null
    return bytes(window ?? null) ?? new Uint8Array(0)
  }

  async setFile(path: string, data: Uint8Array): Promise<void> {
    await this.call('SET', this.fk(path), data)
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    await this.call('APPEND', this.fk(path), data)
  }

  async setFileRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    await this.call('SETRANGE', this.fk(path), offset, data)
  }

  async truncateFile(
    path: string,
    length: number,
    modified: string,
    noCreate = false,
  ): Promise<boolean> {
    const keys = [this.fk(path), this.mk(path)]
    const args = [String(length), modified, noCreate ? '1' : '0']
    return Number(await this.call('EVAL', TRUNCATE_SCRIPT, keys.length, ...keys, ...args)) === 1
  }

  async delFile(path: string): Promise<void> {
    await this.call('DEL', this.fk(path))
  }

  async hasFile(path: string): Promise<boolean> {
    return Number(await this.call('EXISTS', this.fk(path))) > 0
  }

  async listFiles(prefix = ''): Promise<string[]> {
    const head = `${this.keyPrefix}file:`
    const keys = await this.scan(`${escapeGlob(`${head}${prefix}`)}*`)
    return keys.map((key) => key.slice(head.length)).sort(compareCodePoints)
  }

  async fileLen(path: string): Promise<number> {
    return Number(await this.call('STRLEN', this.fk(path)))
  }

  async hasDir(path: string): Promise<boolean> {
    if (path === '/') return true
    return Number(await this.call('SISMEMBER', this.dk(), path)) === 1
  }

  async addDir(path: string): Promise<void> {
    await this.call('SADD', this.dk(), path)
  }

  async removeDir(path: string): Promise<void> {
    await this.call('SREM', this.dk(), path)
  }

  async listDirs(): Promise<Set<string>> {
    const members = list(await this.call('SMEMBERS', this.dk())).map((m) => text(m) ?? '')
    return new Set(['/', ...members])
  }

  async getModified(path: string): Promise<string | null> {
    return text(await this.call('GET', this.mk(path)))
  }

  async setModified(path: string, ts: string): Promise<void> {
    await this.call('SET', this.mk(path), ts)
  }

  async delModified(path: string): Promise<void> {
    await this.call('DEL', this.mk(path))
  }

  async getAttrs(path: string): Promise<Record<string, string>> {
    return record(await this.call('HGETALL', this.ak(path)))
  }

  /** The attributes, length and modified time of many paths, in one round trip. */
  async statMany(
    paths: readonly (readonly [string, boolean])[],
  ): Promise<[Record<string, string>, number | null, string | null][]> {
    const commands: RespArg[][] = []
    for (const [path, isDir] of paths) {
      commands.push(['HGETALL', this.ak(path)])
      if (!isDir) commands.push(['STRLEN', this.fk(path)])
      commands.push(['GET', this.mk(path)])
    }
    const replies = await this.pipeline(commands)
    let at = 0
    return paths.map(([, isDir]) => {
      const attrs = record(replies[at++] ?? null)
      const size = isDir ? null : Number(replies[at++])
      return [attrs, size, text(replies[at++] ?? null)]
    })
  }

  async infoMemory(): Promise<string> {
    return text(await this.call('INFO', 'memory')) ?? ''
  }

  async setAttrs(path: string, fields: Record<string, string>): Promise<void> {
    const pairs = Object.entries(fields).flat()
    if (pairs.length > 0) await this.call('HSET', this.ak(path), ...pairs)
  }

  async delAttrs(path: string): Promise<void> {
    await this.call('DEL', this.ak(path))
  }

  async listAttrs(): Promise<Record<string, Record<string, string>>> {
    const head = `${this.keyPrefix}attrs:`
    const keys = await this.scan(`${escapeGlob(head)}*`)
    const replies = await this.pipeline(keys.map((key) => ['HGETALL', key]))
    return Object.fromEntries(
      keys.map((key, i) => [key.slice(head.length), record(replies[i] ?? null)]),
    )
  }

  async listModified(): Promise<Record<string, string>> {
    const head = `${this.keyPrefix}modified:`
    const keys = await this.scan(`${escapeGlob(head)}*`)
    const replies = await this.pipeline(keys.map((key) => ['GET', key]))
    const out: Record<string, string> = {}
    keys.forEach((key, i) => {
      const ts = text(replies[i] ?? null)
      if (ts !== null) out[key.slice(head.length)] = ts
    })
    return out
  }

  /** Write a whole snapshot as one `MULTI`, as node's store does. */
  async restore(state: RedisRestore): Promise<void> {
    const commands: RespArg[][] = [['MULTI']]
    for (const [path, data] of Object.entries(state.files))
      commands.push(['SET', this.fk(path), data])
    for (const dir of state.dirs) commands.push(['SADD', this.dk(), dir])
    for (const [path, fields] of Object.entries(state.attrs)) {
      const pairs = Object.entries(fields).flat()
      if (pairs.length > 0) commands.push(['HSET', this.ak(path), ...pairs])
    }
    for (const [path, ts] of Object.entries(state.modified))
      commands.push(['SET', this.mk(path), ts])
    commands.push(['EXEC'])
    const replies = await this.pipeline(commands)
    checked(list(replies[replies.length - 1] ?? null))
  }

  async clear(): Promise<void> {
    const p = escapeGlob(this.keyPrefix)
    for (const pattern of [`${p}file:*`, `${p}tmp:*`, `${p}modified:*`, `${p}attrs:*`]) {
      const keys = await this.scan(pattern)
      for (let i = 0; i < keys.length; i += KEY_BATCH) {
        await this.call('DEL', ...keys.slice(i, i + KEY_BATCH))
      }
    }
    await this.call('DEL', this.dk())
    this.seeded = null
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

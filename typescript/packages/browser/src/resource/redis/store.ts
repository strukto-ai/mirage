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

import type { RedisRestore, RedisStoreLike } from '@struktoai/mirage-core/resource/redis/store'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { decodeBase64 } from '@struktoai/mirage-core/utils/base64'
import { escapeGlob } from '@struktoai/mirage-core/core/redis/utils'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

// Upstash caps one REST request at 10 MB on every plan, so a file above this
// goes out as one SET followed by APPENDs, each under the cap with headroom,
// and a DEL or a pipeline is packed to the same budget by serialized size,
// with KEY_BATCH keys as a ceiling on top for a reply that has to fit too.
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024
const SCAN_COUNT = 1000
const KEY_BATCH = 500
const UTF8 = new TextEncoder()

export interface UpstashRedisStoreOptions {
  /**
   * The redis url the Upstash console prints,
   * `rediss://default:<token>@<name>.upstash.io:6379`, which is the url the
   * node and python mounts take; or the REST url, `https://<name>.upstash.io`,
   * with `token` beside it.
   */
  url: string
  /**
   * The REST token. Required with a REST url; a redis url carries it as its
   * password. Read-only tokens cannot SCAN, which readdir needs.
   */
  token?: string
  keyPrefix?: string
  fetchImpl?: typeof fetch
  maxRequestBytes?: number
}

interface RestTarget {
  base: string
  token: string
}

type CommandArg = string | number

/**
 * Where the requests go and what they carry. Upstash hands out one secret
 * that is both the database password and the REST token, so the redis url
 * the node and python mounts take names the REST listener too: `https://`
 * on the same host, with the password as the bearer token. A REST url needs
 * `token` beside it, which is the form a serverless-redis-http front takes,
 * since its token is its own setting and not a redis password. No message
 * echoes the url, because a redis url carries the secret.
 */
function restTarget(options: UpstashRedisStoreOptions): RestTarget {
  if (typeof options.url !== 'string' || options.url === '') {
    throw new Error(
      'redis: url is required, the redis url or the REST url from the Upstash console',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(options.url)
  } catch {
    throw new Error('redis: url must be a redis:// or rediss:// url, or an https:// REST url')
  }
  if (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:') {
    const token =
      parsed.password === '' ? (options.token ?? '') : decodeURIComponent(parsed.password)
    if (token === '') {
      throw new Error(
        'redis: a redis url needs its password, which the Upstash console prints as the token; ' +
          'put it in the url or pass it as token',
      )
    }
    return { base: `https://${parsed.hostname}`, token }
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (typeof options.token !== 'string' || options.token === '') {
      throw new Error('redis: token is required, the database REST token from the Upstash console')
    }
    return { base: rstripSlash(options.url), token: options.token }
  }
  throw new Error('redis: url must be a redis:// or rediss:// url, or an https:// REST url')
}

function unwrap(payload: JsonValue): JsonValue {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('upstash: reply is not an object')
  }
  const error = payload.error
  if (typeof error === 'string') throw new Error(`upstash: ${error}`)
  return payload.result ?? null
}

function expectString(value: JsonValue, command: string): string {
  if (typeof value !== 'string') throw new Error(`upstash: ${command} did not answer a string`)
  return value
}

function expectStrings(value: JsonValue, command: string): string[] {
  if (!Array.isArray(value)) throw new Error(`upstash: ${command} did not answer an array`)
  return value.map((item) => expectString(item, command))
}

/**
 * Splits `items` into runs whose JSON array stays within `limit` UTF-8 bytes
 * and KEY_BATCH entries. An item that alone outgrows the limit still goes out,
 * on its own, so the server is the one to refuse it rather than a silent drop.
 */
function packJson<T>(items: readonly T[], limit: number): T[][] {
  const runs: T[][] = []
  let run: T[] = []
  let bytes = 2
  for (const item of items) {
    const size = UTF8.encode(JSON.stringify(item)).byteLength + 1
    if (run.length > 0 && (run.length >= KEY_BATCH || bytes + size > limit)) {
      runs.push(run)
      run = []
      bytes = 2
    }
    run.push(item)
    bytes += size
  }
  if (run.length > 0) runs.push(run)
  return runs
}

function pairsToRecord(flat: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[flat[i] ?? ''] = flat[i + 1] ?? ''
  }
  return out
}

/**
 * The redis keyspace over Upstash's REST API, so a browser page can mount
 * redis with no socket. Anything that answers that API serves: Upstash
 * itself, or serverless-redis-http in front of any redis. It is configured
 * with the same redis url as the node and python mounts (see `restTarget`).
 *
 * Bytes need care, because a JSON command array carries UTF-8 strings and
 * nothing else. Writes therefore use the path form, `POST /set/<key>` with
 * the raw body as the last argument, and reads ask for `Upstash-Encoding:
 * base64`, which encodes every bulk string in the reply. Both keep the stored
 * value byte-identical to what the node and python stores write, so one
 * database serves all three runtimes. The one thing the path form cannot
 * carry is an empty body, which the server reads as a missing argument, so an
 * empty file is written through the JSON form instead.
 */
export class UpstashRedisStore implements RedisStoreLike {
  readonly url: string
  readonly keyPrefix: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRequestBytes: number

  constructor(options: UpstashRedisStoreOptions) {
    const target = restTarget(options)
    this.url = target.base
    this.token = target.token
    this.keyPrefix = options.keyPrefix ?? 'mirage:fs:'
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    const limit = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('redis: maxRequestBytes must be a positive integer')
    }
    this.maxRequestBytes = limit
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

  private async request(
    path: string,
    body: BodyInit,
    contentType: string,
    base64: boolean,
  ): Promise<JsonValue> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': contentType,
    }
    if (base64) headers['Upstash-Encoding'] = 'base64'
    let response: Response
    try {
      response = await this.fetchImpl(`${this.url}${path}`, { method: 'POST', headers, body })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `upstash: cannot reach ${this.url} (${reason}); a page needs a REST listener at this ` +
          'host, Upstash itself or serverless-redis-http in front of the redis',
      )
    }
    const text = await response.text()
    let payload: JsonValue
    try {
      payload = JSON.parse(text) as JsonValue
    } catch {
      throw new Error(`upstash: HTTP ${String(response.status)} with a non-JSON body`)
    }
    if (!response.ok) {
      const message =
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof payload.error === 'string'
          ? payload.error
          : text
      throw new Error(`upstash: HTTP ${String(response.status)}: ${message}`)
    }
    return payload
  }

  private async command(args: readonly CommandArg[], base64 = false): Promise<JsonValue> {
    return unwrap(await this.request('', JSON.stringify(args), 'application/json', base64))
  }

  private async pipeline(
    commands: readonly (readonly CommandArg[])[],
    base64 = false,
  ): Promise<JsonValue[]> {
    const replies: JsonValue[] = []
    for (const run of packJson(commands, this.maxRequestBytes)) {
      const payload = await this.request(
        '/pipeline',
        JSON.stringify(run),
        'application/json',
        base64,
      )
      if (!Array.isArray(payload)) throw new Error('upstash: pipeline did not answer an array')
      for (const item of payload) replies.push(unwrap(item))
    }
    return replies
  }

  private async raw(command: 'set' | 'append', key: string, data: Uint8Array): Promise<void> {
    unwrap(
      await this.request(
        `/${command}/${encodeURIComponent(key)}`,
        data as BodyInit,
        'application/octet-stream',
        false,
      ),
    )
  }

  private async integer(args: readonly CommandArg[]): Promise<number> {
    const reply = await this.command(args)
    if (typeof reply !== 'number') {
      throw new Error(`upstash: ${String(args[0])} did not answer an integer`)
    }
    return reply
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
      const reply = await this.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT])
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new Error('upstash: SCAN did not answer a cursor and a page')
      }
      cursor = expectString(reply[0] ?? null, 'SCAN')
      for (const key of expectStrings(reply[1] ?? null, 'SCAN')) keys.push(key)
    } while (cursor !== '0')
    return keys
  }

  async open(): Promise<void> {
    await this.command(['SADD', this.dk(), '/'])
  }

  async getFile(path: string): Promise<Uint8Array | null> {
    const reply = await this.command(['GET', this.fk(path)], true)
    if (reply === null) return null
    return decodeBase64(expectString(reply, 'GET'))
  }

  async getFileRange(
    path: string,
    offset: number,
    size: number | null,
  ): Promise<Uint8Array | null> {
    const key = this.fk(path)
    // GETRANGE 0 -1 means the whole value, not an empty window.
    if (size === 0) return (await this.integer(['EXISTS', key])) === 0 ? null : new Uint8Array(0)
    const end = size === null ? -1 : offset + size - 1
    const [exists, raw] = await this.pipeline(
      [
        ['EXISTS', key],
        ['GETRANGE', key, offset, end],
      ],
      true,
    )
    if (exists === 0) return null
    return decodeBase64(expectString(raw ?? null, 'GETRANGE'))
  }

  async setFile(path: string, data: Uint8Array): Promise<void> {
    const key = this.fk(path)
    if (data.byteLength === 0) {
      await this.command(['SET', key, ''])
      return
    }
    const limit = this.maxRequestBytes
    if (data.byteLength <= limit) {
      await this.raw('set', key, data)
      return
    }
    // A chunked write lands on a staging key and is renamed in only once every
    // chunk arrived, so a failed chunk never leaves a truncated file behind and
    // two writers of one path never interleave: the mount keeps the single-SET
    // semantics of the node and python stores.
    const staging = `${this.keyPrefix}tmp:${path}:${crypto.randomUUID()}`
    try {
      await this.raw('set', staging, data.subarray(0, limit))
      for (let offset = limit; offset < data.byteLength; offset += limit) {
        await this.raw('append', staging, data.subarray(offset, offset + limit))
      }
      await this.command(['RENAME', staging, key])
    } catch (err) {
      await this.command(['DEL', staging])
      throw err
    }
  }

  async delFile(path: string): Promise<void> {
    await this.command(['DEL', this.fk(path)])
  }

  async hasFile(path: string): Promise<boolean> {
    return (await this.integer(['EXISTS', this.fk(path)])) > 0
  }

  async listFiles(prefix = ''): Promise<string[]> {
    const head = `${this.keyPrefix}file:`
    const keys = await this.scan(`${escapeGlob(`${head}${prefix}`)}*`)
    return keys.map((key) => key.slice(head.length)).sort(compareCodePoints)
  }

  fileLen(path: string): Promise<number> {
    return this.integer(['STRLEN', this.fk(path)])
  }

  async hasDir(path: string): Promise<boolean> {
    return (await this.integer(['SISMEMBER', this.dk(), path])) === 1
  }

  async addDir(path: string): Promise<void> {
    await this.command(['SADD', this.dk(), path])
  }

  async removeDir(path: string): Promise<void> {
    await this.command(['SREM', this.dk(), path])
  }

  async listDirs(): Promise<Set<string>> {
    return new Set(expectStrings(await this.command(['SMEMBERS', this.dk()]), 'SMEMBERS'))
  }

  async getModified(path: string): Promise<string | null> {
    const reply = await this.command(['GET', this.mk(path)])
    return reply === null ? null : expectString(reply, 'GET')
  }

  async setModified(path: string, ts: string): Promise<void> {
    await this.command(['SET', this.mk(path), ts])
  }

  async delModified(path: string): Promise<void> {
    await this.command(['DEL', this.mk(path)])
  }

  async getAttrs(path: string): Promise<Record<string, string>> {
    return pairsToRecord(expectStrings(await this.command(['HGETALL', this.ak(path)]), 'HGETALL'))
  }

  async setAttrs(path: string, fields: Record<string, string>): Promise<void> {
    const flat = Object.entries(fields).flat()
    if (flat.length === 0) return
    await this.command(['HSET', this.ak(path), ...flat])
  }

  async delAttrs(path: string): Promise<void> {
    await this.command(['DEL', this.ak(path)])
  }

  async listAttrs(): Promise<Record<string, Record<string, string>>> {
    const head = `${this.keyPrefix}attrs:`
    const keys = await this.scan(`${escapeGlob(head)}*`)
    const replies = await this.pipeline(keys.map((key) => ['HGETALL', key]))
    const out: Record<string, Record<string, string>> = {}
    keys.forEach((key, i) => {
      out[key.slice(head.length)] = pairsToRecord(expectStrings(replies[i] ?? null, 'HGETALL'))
    })
    return out
  }

  async listModified(): Promise<Record<string, string>> {
    const head = `${this.keyPrefix}modified:`
    const keys = await this.scan(`${escapeGlob(head)}*`)
    const replies = await this.pipeline(keys.map((key) => ['GET', key]))
    const out: Record<string, string> = {}
    keys.forEach((key, i) => {
      const reply = replies[i] ?? null
      if (reply !== null) out[key.slice(head.length)] = expectString(reply, 'GET')
    })
    return out
  }

  async restore(state: RedisRestore): Promise<void> {
    for (const [path, data] of Object.entries(state.files)) {
      await this.setFile(path, data)
    }
    const commands: CommandArg[][] = []
    for (const dir of state.dirs) commands.push(['SADD', this.dk(), dir])
    for (const [path, fields] of Object.entries(state.attrs)) {
      const flat = Object.entries(fields).flat()
      if (flat.length > 0) commands.push(['HSET', this.ak(path), ...flat])
    }
    for (const [path, ts] of Object.entries(state.modified)) {
      commands.push(['SET', this.mk(path), ts])
    }
    await this.pipeline(commands)
  }

  async clear(): Promise<void> {
    const p = escapeGlob(this.keyPrefix)
    for (const pattern of [`${p}file:*`, `${p}tmp:*`, `${p}modified:*`, `${p}attrs:*`]) {
      const keys = await this.scan(pattern)
      for (const run of packJson(keys, this.maxRequestBytes - '"DEL",'.length)) {
        await this.command(['DEL', ...run])
      }
    }
    await this.command(['DEL', this.dk()])
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

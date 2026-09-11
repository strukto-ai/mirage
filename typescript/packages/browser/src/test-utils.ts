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

import type { JsonValue } from '@struktoai/mirage-core/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import { encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import { OPFSAccessor } from './accessor/opfs.ts'

export function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

interface DirNode {
  kind: 'directory'
  name: string
  children: Map<string, DirNode | FileNode>
}

interface FileNode {
  kind: 'file'
  name: string
  data: Uint8Array
  modified: Date
}

class MockWritable {
  constructor(private readonly file: FileNode) {}
  async write(data: Blob | BufferSource | string): Promise<void> {
    if (typeof data === 'string') {
      this.file.data = new TextEncoder().encode(data)
    } else if (data instanceof Blob) {
      const buf = new Uint8Array(await data.arrayBuffer())
      this.file.data = buf
    } else if (data instanceof ArrayBuffer) {
      this.file.data = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      this.file.data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
    } else {
      throw new TypeError('MockWritable.write: unsupported data type')
    }
    this.file.modified = new Date()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

class MockFileHandle {
  readonly kind = 'file'
  constructor(private readonly node: FileNode) {}
  get name(): string {
    return this.node.name
  }
  getFile(): Promise<File> {
    const blob = new Blob([this.node.data.slice()])
    const file = new File([blob], this.node.name, { lastModified: this.node.modified.getTime() })
    return Promise.resolve(file)
  }
  createWritable(): Promise<MockWritable> {
    return Promise.resolve(new MockWritable(this.node))
  }
}

function notFound(name: string): DOMException {
  return new DOMException(
    `A requested file or directory could not be found: ${name}`,
    'NotFoundError',
  )
}

class MockDirectoryHandle {
  readonly kind = 'directory'
  constructor(private readonly node: DirNode) {}
  get name(): string {
    return this.node.name
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<MockDirectoryHandle> {
    const existing = this.node.children.get(name)
    if (existing !== undefined) {
      if (existing.kind !== 'directory') {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      return new MockDirectoryHandle(existing)
    }
    if (options.create !== true) throw notFound(name)
    const dir: DirNode = { kind: 'directory', name, children: new Map() }
    this.node.children.set(name, dir)
    return new MockDirectoryHandle(dir)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MockFileHandle> {
    const existing = this.node.children.get(name)
    if (existing !== undefined) {
      if (existing.kind !== 'file') {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }
      return new MockFileHandle(existing)
    }
    if (options.create !== true) throw notFound(name)
    const file: FileNode = { kind: 'file', name, data: new Uint8Array(), modified: new Date() }
    this.node.children.set(name, file)
    return new MockFileHandle(file)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const existing = this.node.children.get(name)
    if (existing === undefined) throw notFound(name)
    if (existing.kind === 'directory' && existing.children.size > 0 && options.recursive !== true) {
      throw new DOMException('Directory not empty', 'InvalidModificationError')
    }
    this.node.children.delete(name)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirectoryHandle]> {
    for (const [name, child] of this.node.children) {
      if (child.kind === 'file') yield [name, new MockFileHandle(child)]
      else yield [name, new MockDirectoryHandle(child)]
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<
    [string, MockFileHandle | MockDirectoryHandle]
  > {
    yield* this.entries()
  }
}

export function makeMockRoot(name = 'root'): FileSystemDirectoryHandle {
  const node: DirNode = { kind: 'directory', name, children: new Map() }
  return new MockDirectoryHandle(node) as unknown as FileSystemDirectoryHandle
}

function fakeOPFSResource(handle: FileSystemDirectoryHandle): {
  requireHandle: () => FileSystemDirectoryHandle
} {
  return { requireHandle: () => handle }
}

export function makeMockAccessor(name = 'root'): OPFSAccessor {
  return new OPFSAccessor(fakeOPFSResource(makeMockRoot(name)))
}

export function installFakeNavigator(getRoot: () => FileSystemDirectoryHandle): () => void {
  const fake = { storage: { getDirectory: () => Promise.resolve(getRoot()) } }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: fake,
    configurable: true,
    writable: true,
  })
  return () => {
    if (desc !== undefined) Object.defineProperty(globalThis, 'navigator', desc)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type StoredValue =
  | { kind: 'string'; data: Uint8Array }
  | { kind: 'set'; members: Set<string> }
  | { kind: 'hash'; fields: Map<string, string> }

type Arg = string | Uint8Array
type Reply = null | number | string | Uint8Array | Reply[]

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value'

export interface FakeUpstashOptions {
  url?: string
  token?: string
  /** Largest SCAN page the fake hands back, whatever COUNT asked for. */
  scanPageSize?: number
}

export interface FakeUpstash {
  readonly url: string
  readonly token: string
  readonly fetch: typeof fetch
  /** Every command the fake ran, uppercased, in order, pipelines flattened. */
  readonly commands: string[]
  keys(): string[]
  exec(args: readonly Arg[]): Reply
}

function argBytes(a: Arg): Uint8Array {
  return typeof a === 'string' ? ENC.encode(a) : a
}

function argText(a: Arg): string {
  return typeof a === 'string' ? a : DEC.decode(a)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? ''
    if (ch === '\\' && i + 1 < pattern.length) {
      i++
      out += escapeRegExp(pattern[i] ?? '')
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) throw new Error('ERR unbalanced [ in pattern')
      const body = pattern.slice(i + 1, close)
      out += `[${body.startsWith('^') ? '^' : ''}${body.replace(/^\^/, '').replace(/[\\\]]/g, '\\$&')}]`
      i = close
    } else if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += escapeRegExp(ch)
  }
  return new RegExp(`${out}$`)
}

function wrongArity(name: string): Error {
  return new Error(`ERR wrong number of arguments for '${name.toLowerCase()}' command`)
}

/**
 * The slice of Redis the Upstash store speaks, on a Map. Values are bytes so
 * the fake is binary-safe exactly where the real server is, and a JSON string
 * argument lands as its UTF-8 encoding, which is what Upstash does with one.
 */
class FakeRedis {
  readonly data = new Map<string, StoredValue>()
  private readonly scanPageSize: number

  constructor(scanPageSize: number) {
    this.scanPageSize = scanPageSize
  }

  private bytesAt(key: string): Uint8Array | null {
    const v = this.data.get(key)
    if (v === undefined) return null
    if (v.kind !== 'string') throw new Error(WRONGTYPE)
    return v.data
  }

  private setAt(key: string, create: boolean): Set<string> | null {
    const v = this.data.get(key)
    if (v === undefined) {
      if (!create) return null
      const members = new Set<string>()
      this.data.set(key, { kind: 'set', members })
      return members
    }
    if (v.kind !== 'set') throw new Error(WRONGTYPE)
    return v.members
  }

  private hashAt(key: string, create: boolean): Map<string, string> | null {
    const v = this.data.get(key)
    if (v === undefined) {
      if (!create) return null
      const fields = new Map<string, string>()
      this.data.set(key, { kind: 'hash', fields })
      return fields
    }
    if (v.kind !== 'hash') throw new Error(WRONGTYPE)
    return v.fields
  }

  exec(args: readonly Arg[]): Reply {
    const [head, ...rest] = args
    if (head === undefined) throw new Error('ERR empty command')
    const name = argText(head).toUpperCase()
    const key = rest[0] === undefined ? '' : argText(rest[0])
    switch (name) {
      case 'PING':
        return 'PONG'
      case 'GET':
        if (rest.length !== 1) throw wrongArity(name)
        return this.bytesAt(key)
      case 'SET': {
        if (rest.length !== 2) throw wrongArity(name)
        this.data.set(key, { kind: 'string', data: argBytes(rest[1] ?? '').slice() })
        return 'OK'
      }
      case 'APPEND': {
        if (rest.length !== 2) throw wrongArity(name)
        const next = concatBytes(this.bytesAt(key) ?? new Uint8Array(0), argBytes(rest[1] ?? ''))
        this.data.set(key, { kind: 'string', data: next })
        return next.length
      }
      case 'STRLEN':
        if (rest.length !== 1) throw wrongArity(name)
        return (this.bytesAt(key) ?? new Uint8Array(0)).length
      case 'GETRANGE': {
        if (rest.length !== 3) throw wrongArity(name)
        const data = this.bytesAt(key) ?? new Uint8Array(0)
        const n = data.length
        let start = Number(argText(rest[1] ?? '0'))
        let end = Number(argText(rest[2] ?? '-1'))
        if (start < 0) start = Math.max(n + start, 0)
        if (end < 0) end = n + end
        end = Math.min(end, n - 1)
        return start > end ? new Uint8Array(0) : data.slice(start, end + 1)
      }
      case 'RENAME': {
        if (rest.length !== 2) throw wrongArity(name)
        const v = this.data.get(key)
        if (v === undefined) throw new Error('ERR no such key')
        this.data.delete(key)
        this.data.set(argText(rest[1] ?? ''), v)
        return 'OK'
      }
      case 'DEL':
      case 'EXISTS': {
        if (rest.length === 0) throw wrongArity(name)
        let count = 0
        for (const k of rest) {
          const present = this.data.has(argText(k))
          if (present) count++
          if (present && name === 'DEL') this.data.delete(argText(k))
        }
        return count
      }
      case 'SADD': {
        if (rest.length < 2) throw wrongArity(name)
        const members = this.setAt(key, true) ?? new Set<string>()
        let added = 0
        for (const m of rest.slice(1)) {
          const text = argText(m)
          if (!members.has(text)) added++
          members.add(text)
        }
        return added
      }
      case 'SREM': {
        if (rest.length < 2) throw wrongArity(name)
        const members = this.setAt(key, false)
        if (members === null) return 0
        let removed = 0
        for (const m of rest.slice(1)) if (members.delete(argText(m))) removed++
        if (members.size === 0) this.data.delete(key)
        return removed
      }
      case 'SISMEMBER': {
        if (rest.length !== 2) throw wrongArity(name)
        const members = this.setAt(key, false)
        return members?.has(argText(rest[1] ?? '')) === true ? 1 : 0
      }
      case 'SMEMBERS': {
        if (rest.length !== 1) throw wrongArity(name)
        const members = this.setAt(key, false)
        return members === null ? [] : [...members].map((m) => ENC.encode(m))
      }
      case 'HSET': {
        if (rest.length < 3 || (rest.length - 1) % 2 !== 0) throw wrongArity(name)
        const fields = this.hashAt(key, true) ?? new Map<string, string>()
        let added = 0
        for (let i = 1; i < rest.length; i += 2) {
          const field = argText(rest[i] ?? '')
          if (!fields.has(field)) added++
          fields.set(field, argText(rest[i + 1] ?? ''))
        }
        return added
      }
      case 'HGETALL': {
        if (rest.length !== 1) throw wrongArity(name)
        const fields = this.hashAt(key, false)
        if (fields === null) return []
        const out: Reply[] = []
        for (const [field, value] of fields) out.push(ENC.encode(field), ENC.encode(value))
        return out
      }
      case 'SCAN': {
        if (rest.length === 0) throw wrongArity(name)
        const cursor = Number(key)
        let match: RegExp | null = null
        let count = 10
        for (let i = 1; i < rest.length; i += 2) {
          const option = argText(rest[i] ?? '').toUpperCase()
          const value = argText(rest[i + 1] ?? '')
          if (option === 'MATCH') match = globRegExp(value)
          else if (option === 'COUNT') count = Number(value)
          else throw new Error('ERR syntax error')
        }
        const keys = [...this.data.keys()]
        const page = Math.min(count, this.scanPageSize)
        const slice = keys.slice(cursor, cursor + page)
        const next = cursor + page >= keys.length ? 0 : cursor + page
        const found = slice.filter((k) => match === null || match.test(k))
        return [ENC.encode(String(next)), found.map((k) => ENC.encode(k))]
      }
      default:
        throw new Error(`ERR Command is not available: '${name}'`)
    }
  }
}

function parseJsonArgs(raw: unknown): Arg[] {
  if (!Array.isArray(raw)) throw new Error('ERR command must be an array')
  return raw.map((item) => {
    if (typeof item === 'string') return item
    if (typeof item === 'number' || typeof item === 'boolean') return String(item)
    throw new Error('ERR unsupported argument type')
  })
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array(0)
  if (typeof body === 'string') return ENC.encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw new Error('fake upstash: unsupported request body')
}

function encodeReply(reply: Reply, base64: boolean): JsonValue {
  if (reply === null || typeof reply === 'number' || typeof reply === 'string') return reply
  if (reply instanceof Uint8Array) return base64 ? encodeBase64(reply) : DEC.decode(reply)
  return reply.map((r) => encodeReply(r, base64))
}

function jsonResponse(status: number, payload: JsonValue): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * An in-process stand-in for the Upstash Redis REST API, exposed as a `fetch`.
 *
 * It speaks the three request shapes the store uses and the real service
 * answers: a JSON command array POSTed to the base URL, an array of those at
 * `/pipeline`, and the path form `/<command>/<arg>...` where a POST body is
 * appended as the last argument, which is the one way to send bytes that are
 * not UTF-8. `Upstash-Encoding: base64` base64-encodes every bulk string in
 * the reply and leaves `OK` alone. Errors come back as `{error}` with 400, a
 * bad token as 401, both as the live service does.
 */
export function createFakeUpstash(options: FakeUpstashOptions = {}): FakeUpstash {
  const url = (options.url ?? 'https://fake.upstash.io').replace(/\/+$/, '')
  const token = options.token ?? 'fake-token'
  const redis = new FakeRedis(options.scanPageSize ?? 1000)
  const commands: string[] = []
  const origin = new URL(url)
  const basePath = origin.pathname.replace(/\/+$/, '')

  const one = (
    args: readonly Arg[],
    base64: boolean,
  ): { result: JsonValue } | { error: string } => {
    const head = args[0]
    if (head !== undefined) commands.push(argText(head).toUpperCase())
    try {
      return { result: encodeReply(redis.exec(args), base64) }
    } catch (err) {
      if (err instanceof Error) return { error: err.message }
      return { error: typeof err === 'string' ? err : 'unknown error' }
    }
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(target)
    if (parsed.origin !== origin.origin || !parsed.pathname.startsWith(basePath)) {
      return jsonResponse(404, { error: `fake upstash: unexpected url ${target}` })
    }
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${token}`) {
      return jsonResponse(401, { error: 'WRONGPASS invalid or missing auth token' })
    }
    const base64 = headers.get('upstash-encoding') === 'base64'
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = await bodyBytes(init?.body)
    const segments = parsed.pathname
      .slice(basePath.length)
      .split('/')
      .filter((s) => s !== '')
    if (segments.length === 0) {
      const out = one(parseJsonArgs(JSON.parse(DEC.decode(body))), base64)
      return jsonResponse('error' in out ? 400 : 200, out)
    }
    if (segments[0] === 'pipeline' || segments[0] === 'multi-exec') {
      const raw = JSON.parse(DEC.decode(body)) as unknown
      if (!Array.isArray(raw)) return jsonResponse(400, { error: 'ERR pipeline must be an array' })
      return jsonResponse(
        200,
        raw.map((item) => one(parseJsonArgs(item), base64)),
      )
    }
    const args: Arg[] = segments.map((s) => decodeURIComponent(s))
    if (method === 'POST' && body.length > 0) args.push(body)
    const out = one(args, base64)
    return jsonResponse('error' in out ? 400 : 200, out)
  }

  return {
    url,
    token,
    fetch: fetchImpl,
    commands,
    keys: () => [...redis.data.keys()],
    exec: (args) => redis.exec(args),
  }
}

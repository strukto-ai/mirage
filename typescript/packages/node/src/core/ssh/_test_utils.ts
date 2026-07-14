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

import { Readable, Writable } from 'node:stream'
import type {
  FileEntryWithStats,
  ReadStream,
  ReadStreamOptions,
  SFTPWrapper,
  Stats,
  WriteStream,
  WriteStreamOptions,
} from 'ssh2'
import { SSHAccessor } from '../../accessor/ssh.ts'
import type { SSHConfig } from '../../resource/ssh/config.ts'
import { rstripSlash } from '@struktoai/mirage-core'

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

interface FakeSftpFile {
  data: Uint8Array
  attrs?: Partial<Stats> | undefined
}

export interface FakeSftp {
  files: Map<string, FakeSftpFile>
  dirs: Map<string, Partial<Stats>>
}

interface FakeHandle {
  path: string
  flags: string
  position: number
}

function noSuchFile(path: string): Error & { code: number } {
  const err = new Error(`No such file: ${path}`) as Error & { code: number }
  err.code = 2
  return err
}

function failure(msg: string): Error & { code: number } {
  const err = new Error(msg) as Error & { code: number }
  err.code = 4
  return err
}

function makeStats(attrs: Partial<Stats>, size: number, isDir: boolean): Stats {
  const mode = attrs.mode ?? (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644)
  const stats: Stats = {
    size: attrs.size ?? size,
    mode,
    uid: attrs.uid ?? 0,
    gid: attrs.gid ?? 0,
    mtime: attrs.mtime ?? 0,
    atime: attrs.atime ?? 0,
    isDirectory: () => (mode & 0o170000) === S_IFDIR,
    isFile: () => (mode & 0o170000) === S_IFREG,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }
  return stats
}

function statForPath(state: FakeSftp, path: string): Stats | null {
  const file = state.files.get(path)
  if (file !== undefined) return makeStats(file.attrs ?? {}, file.data.byteLength, false)
  const dir = state.dirs.get(path)
  if (dir !== undefined) return makeStats(dir, 0, true)
  return null
}

function children(state: FakeSftp, dir: string): FileEntryWithStats[] {
  const base = dir === '/' ? '/' : `${rstripSlash(dir)}/`
  const seen = new Set<string>()
  const entries: FileEntryWithStats[] = []
  for (const [path, file] of state.files) {
    if (!path.startsWith(base)) continue
    const rest = path.slice(base.length)
    if (rest === '' || rest.includes('/')) {
      const top = rest.split('/')[0]
      if (top !== undefined && top.length > 0 && !seen.has(top)) {
        const childPath = `${base}${top}`
        const childDir = state.dirs.get(childPath)
        if (childDir !== undefined) {
          seen.add(top)
          entries.push({
            filename: top,
            longname: top,
            attrs: makeStats(childDir, 0, true),
          })
        }
      }
      continue
    }
    if (seen.has(rest)) continue
    seen.add(rest)
    entries.push({
      filename: rest,
      longname: rest,
      attrs: makeStats(file.attrs ?? {}, file.data.byteLength, false),
    })
  }
  for (const [path, attrs] of state.dirs) {
    if (path === dir) continue
    if (!path.startsWith(base)) continue
    const rest = path.slice(base.length)
    if (rest === '' || rest.includes('/')) continue
    if (seen.has(rest)) continue
    seen.add(rest)
    entries.push({
      filename: rest,
      longname: rest,
      attrs: makeStats(attrs, 0, true),
    })
  }
  return entries
}

function parentDir(path: string): string {
  if (path === '/' || !path.startsWith('/')) return '/'
  const trimmed = rstripSlash(path)
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

function decodeHandle(handle: Buffer): FakeHandle | null {
  try {
    const obj = JSON.parse(handle.toString('utf-8')) as unknown
    if (obj === null || typeof obj !== 'object') return null
    const p = (obj as { path?: unknown }).path
    const f = (obj as { flags?: unknown }).flags
    const pos = (obj as { position?: unknown }).position
    if (typeof p !== 'string' || typeof f !== 'string' || typeof pos !== 'number') return null
    return { path: p, flags: f, position: pos }
  } catch {
    return null
  }
}

function encodeHandle(h: FakeHandle): Buffer {
  return Buffer.from(JSON.stringify(h), 'utf-8')
}

function unimplemented(name: string): never {
  throw new Error(`fake sftp: ${name} not implemented`)
}

function makeFakeSftp(state: FakeSftp): SFTPWrapper {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      const key = String(prop)
      if (key in target) return target[key]
      if (key === 'then') return undefined
      return () => unimplemented(key)
    },
  }
  const impl: Record<string, unknown> = {
    readFile(
      path: string,
      arg2:
        | { encoding?: BufferEncoding }
        | BufferEncoding
        | ((err: Error | undefined, buf: Buffer) => void),
      arg3?: (err: Error | undefined, buf: Buffer) => void,
    ): void {
      const cb = typeof arg2 === 'function' ? arg2 : arg3
      if (cb === undefined) throw new Error('fake sftp: readFile requires a callback')
      const file = state.files.get(path)
      if (file === undefined) {
        cb(noSuchFile(path), Buffer.alloc(0))
        return
      }
      cb(undefined, Buffer.from(file.data))
    },
    readdir(path: string, cb: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
      if (!state.dirs.has(path)) {
        cb(noSuchFile(path), [])
        return
      }
      cb(undefined, children(state, path))
    },
    lstat(path: string, cb: (err: Error | undefined, stats: Stats) => void): void {
      const stats = statForPath(state, path)
      if (stats === null) {
        cb(noSuchFile(path), undefined as unknown as Stats)
        return
      }
      cb(undefined, stats)
    },
    stat(path: string, cb: (err: Error | undefined, stats: Stats) => void): void {
      const stats = statForPath(state, path)
      if (stats === null) {
        cb(noSuchFile(path), undefined as unknown as Stats)
        return
      }
      cb(undefined, stats)
    },
    exists(path: string, cb: (yes: boolean) => void): void {
      cb(statForPath(state, path) !== null)
    },
    createReadStream(path: string, options?: ReadStreamOptions): ReadStream {
      const file = state.files.get(path)
      if (file === undefined) {
        const r = new Readable({
          read() {
            this.destroy(noSuchFile(path))
          },
        })
        return r as unknown as ReadStream
      }
      const start = options?.start ?? 0
      const end = options?.end !== undefined ? options.end + 1 : file.data.byteLength
      const slice = file.data.subarray(start, end)
      const r = Readable.from([Buffer.from(slice)])
      return r as unknown as ReadStream
    },
    writeFile(
      path: string,
      data: string | Buffer | Uint8Array,
      arg3: { encoding?: BufferEncoding } | BufferEncoding | ((err: Error | undefined) => void),
      arg4?: (err: Error | undefined) => void,
    ): void {
      const cb = typeof arg3 === 'function' ? arg3 : arg4
      if (cb === undefined) throw new Error('fake sftp: writeFile requires a callback')
      if (state.dirs.has(path)) {
        cb(failure(`is a directory: ${path}`))
        return
      }
      const parent = parentDir(path)
      if (!state.dirs.has(parent)) {
        cb(noSuchFile(parent))
        return
      }
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data instanceof Buffer
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data
      state.files.set(path, { data: new Uint8Array(bytes) })
      cb(undefined)
    },
    appendFile(
      path: string,
      data: string | Buffer | Uint8Array,
      arg3: { encoding?: BufferEncoding } | BufferEncoding | ((err: Error | undefined) => void),
      arg4?: (err: Error | undefined) => void,
    ): void {
      const cb = typeof arg3 === 'function' ? arg3 : arg4
      if (cb === undefined) throw new Error('fake sftp: appendFile requires a callback')
      if (state.dirs.has(path)) {
        cb(failure(`is a directory: ${path}`))
        return
      }
      const parent = parentDir(path)
      if (!state.dirs.has(parent)) {
        cb(noSuchFile(parent))
        return
      }
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data instanceof Buffer
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data
      const existing = state.files.get(path)
      if (existing === undefined) {
        state.files.set(path, { data: new Uint8Array(bytes) })
      } else {
        const merged = new Uint8Array(existing.data.byteLength + bytes.byteLength)
        merged.set(existing.data, 0)
        merged.set(bytes, existing.data.byteLength)
        state.files.set(path, { data: merged, attrs: existing.attrs })
      }
      cb(undefined)
    },
    open(
      path: string,
      mode: string | number,
      arg3:
        | { mode?: number | string }
        | string
        | number
        | ((err: Error | undefined, handle: Buffer) => void),
      arg4?: (err: Error | undefined, handle: Buffer) => void,
    ): void {
      const cb = typeof arg3 === 'function' ? arg3 : arg4
      if (cb === undefined) throw new Error('fake sftp: open requires a callback')
      const flags = typeof mode === 'string' ? mode : 'r'
      if (state.dirs.has(path)) {
        cb(failure(`is a directory: ${path}`), Buffer.alloc(0))
        return
      }
      const exists = state.files.has(path)
      if (flags === 'wx' && exists) {
        cb(failure(`file exists: ${path}`), Buffer.alloc(0))
        return
      }
      if (flags === 'r' && !exists) {
        cb(noSuchFile(path), Buffer.alloc(0))
        return
      }
      const parent = parentDir(path)
      if (!state.dirs.has(parent)) {
        cb(noSuchFile(parent), Buffer.alloc(0))
        return
      }
      if (flags === 'w' || flags === 'wx') {
        state.files.set(path, { data: new Uint8Array(0) })
      } else if (flags === 'a') {
        if (!exists) state.files.set(path, { data: new Uint8Array(0) })
      } else if (!exists && flags !== 'r') {
        state.files.set(path, { data: new Uint8Array(0) })
      }
      const startPos = flags === 'a' ? (state.files.get(path)?.data.byteLength ?? 0) : 0
      cb(undefined, encodeHandle({ path, flags, position: startPos }))
    },
    close(handle: Buffer, cb: (err: Error | undefined) => void): void {
      decodeHandle(handle)
      cb(undefined)
    },
    write(
      handle: Buffer,
      buffer: Buffer | Uint8Array,
      offset: number,
      length: number,
      position: number,
      cb: (err: Error | undefined) => void,
    ): void {
      const h = decodeHandle(handle)
      if (h === null) {
        cb(failure('invalid handle'))
        return
      }
      const file = state.files.get(h.path) ?? { data: new Uint8Array(0) }
      const src =
        buffer instanceof Buffer
          ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          : buffer
      const slice = src.subarray(offset, offset + length)
      const writeAt = position
      const newSize = Math.max(file.data.byteLength, writeAt + slice.byteLength)
      const merged = new Uint8Array(newSize)
      merged.set(file.data, 0)
      merged.set(slice, writeAt)
      state.files.set(h.path, { data: merged, attrs: file.attrs })
      cb(undefined)
    },
    fstat(handle: Buffer, cb: (err: Error | undefined, stats: Stats) => void): void {
      const h = decodeHandle(handle)
      if (h === null) {
        cb(failure('invalid handle'), undefined as unknown as Stats)
        return
      }
      const stats = statForPath(state, h.path)
      if (stats === null) {
        cb(noSuchFile(h.path), undefined as unknown as Stats)
        return
      }
      cb(undefined, stats)
    },
    setstat(
      path: string,
      attrs: { size?: number; mode?: number | string },
      cb: (err: Error | undefined) => void,
    ): void {
      const file = state.files.get(path)
      if (file === undefined) {
        cb(noSuchFile(path))
        return
      }
      if (attrs.size !== undefined) {
        const len = attrs.size
        const out = new Uint8Array(len)
        out.set(file.data.subarray(0, Math.min(file.data.byteLength, len)))
        state.files.set(path, { data: out, attrs: file.attrs })
      }
      cb(undefined)
    },
    mkdir(
      path: string,
      arg2: { mode?: number | string } | ((err: Error | undefined) => void),
      arg3?: (err: Error | undefined) => void,
    ): void {
      const cb = typeof arg2 === 'function' ? arg2 : arg3
      if (cb === undefined) throw new Error('fake sftp: mkdir requires a callback')
      if (state.dirs.has(path) || state.files.has(path)) {
        cb(failure(`already exists: ${path}`))
        return
      }
      const parent = parentDir(path)
      if (!state.dirs.has(parent)) {
        cb(noSuchFile(parent))
        return
      }
      state.dirs.set(path, {})
      cb(undefined)
    },
    rmdir(path: string, cb: (err: Error | undefined) => void): void {
      if (!state.dirs.has(path)) {
        cb(noSuchFile(path))
        return
      }
      const base = path === '/' ? '/' : `${rstripSlash(path)}/`
      for (const k of state.files.keys()) {
        if (k.startsWith(base)) {
          cb(failure(`directory not empty: ${path}`))
          return
        }
      }
      for (const k of state.dirs.keys()) {
        if (k === path) continue
        if (k.startsWith(base)) {
          cb(failure(`directory not empty: ${path}`))
          return
        }
      }
      state.dirs.delete(path)
      cb(undefined)
    },
    rename(oldPath: string, newPath: string, cb: (err: Error | undefined) => void): void {
      const parent = parentDir(newPath)
      if (!state.dirs.has(parent)) {
        cb(noSuchFile(parent))
        return
      }
      const file = state.files.get(oldPath)
      if (file !== undefined) {
        state.files.delete(oldPath)
        state.files.set(newPath, file)
        cb(undefined)
        return
      }
      const dir = state.dirs.get(oldPath)
      if (dir !== undefined) {
        const base = oldPath === '/' ? '/' : `${rstripSlash(oldPath)}/`
        const newBase = newPath === '/' ? '/' : `${rstripSlash(newPath)}/`
        const fileMoves: [string, FakeSftpFile][] = []
        for (const [k, v] of state.files) {
          if (k.startsWith(base)) {
            fileMoves.push([newBase + k.slice(base.length), v])
          }
        }
        const dirMoves: [string, Partial<Stats>][] = []
        for (const [k, v] of state.dirs) {
          if (k === oldPath || k.startsWith(base)) {
            const newK = k === oldPath ? newPath : newBase + k.slice(base.length)
            dirMoves.push([newK, v])
          }
        }
        for (const k of [...state.files.keys()]) if (k.startsWith(base)) state.files.delete(k)
        for (const k of [...state.dirs.keys()]) {
          if (k === oldPath || k.startsWith(base)) state.dirs.delete(k)
        }
        for (const [k, v] of fileMoves) state.files.set(k, v)
        for (const [k, v] of dirMoves) state.dirs.set(k, v)
        cb(undefined)
        return
      }
      cb(noSuchFile(oldPath))
    },
    unlink(path: string, cb: (err: Error | undefined) => void): void {
      if (!state.files.has(path)) {
        cb(noSuchFile(path))
        return
      }
      state.files.delete(path)
      cb(undefined)
    },
    createWriteStream(path: string, options?: WriteStreamOptions): WriteStream {
      const flags = options?.flags ?? 'w'
      const chunks: Buffer[] = []
      const w = new Writable({
        write(chunk: Buffer | string, _enc, cbInner): void {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          cbInner()
        },
        final(cbInner): void {
          const merged = Buffer.concat(chunks)
          const parent = parentDir(path)
          if (!state.dirs.has(parent)) {
            cbInner(noSuchFile(parent))
            return
          }
          const existing = flags === 'a' ? state.files.get(path) : undefined
          if (existing !== undefined) {
            const out = new Uint8Array(existing.data.byteLength + merged.byteLength)
            out.set(existing.data, 0)
            out.set(merged, existing.data.byteLength)
            state.files.set(path, { data: out, attrs: existing.attrs })
          } else {
            state.files.set(path, {
              data: new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
            })
          }
          cbInner()
        },
      })
      return w as unknown as WriteStream
    },
  }
  return new Proxy(impl, handler) as unknown as SFTPWrapper
}

export function makeFakeAccessor(state: FakeSftp, root = '/'): SSHAccessor {
  const config: SSHConfig = { host: 'fake', root }
  const accessor = new SSHAccessor(config)
  const fake = makeFakeSftp(state)
  accessor.sftp = () => Promise.resolve(fake)
  return accessor
}

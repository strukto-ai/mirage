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

import { GitConfigManager } from 'isomorphic-git/managers'
import { FileSystem } from 'isomorphic-git/models'

import { isMissingPath } from '../../../../errors/fs.ts'
import { FileType, PathSpec, type FileStat } from '../../../../types.ts'
import { IDX_SUFFIX, PACK_BLOCK, PACK_BLOCKS, PACK_CACHE_BYTES, PACK_DIR } from './constants.ts'
import { GitError } from './errors.ts'
import {
  ensureDir,
  exists,
  readNames,
  readOptional,
  readRange,
  removeFile,
  statOf,
  writeFile as writePath,
} from './io.ts'
import { concat } from '../../../../utils/bytes.ts'
import { toHex, fromHex } from '../../../../utils/hex.ts'
import { entryName } from '../../../../utils/remnants.ts'
import { posixNormpath } from '../../../../utils/path.ts'
import type { RepoLocation } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const LOOSE = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/
/** What a packed object that cannot be read is served as: nothing inflates from it. */
const UNREADABLE = new Uint8Array([0x78, 0x00])

export const KINDS = ['commit', 'tree', 'blob', 'tag']
export const OFS_DELTA = 6
const REF_DELTA = 7
export const SHA_BYTES = 20
export const IDX_MAGIC = [0xff, 0x74, 0x4f, 0x63]
export const FANOUT_SIZE = 256 * 4
export const V2_HEADER = 8
const V1_ENTRY = 4 + SHA_BYTES
export const LARGE = 0x80000000
const STORED_BLOCK = 0xffff
const ADLER_MOD = 65521
const ADLER_RUN = 5552

/** One object a packed read hands back: its type and its content. */
export interface Packed {
  readonly type: string
  readonly content: Uint8Array
}

/** One pack, as far as reading has opened its index. */
interface PackFile {
  readonly idx: PathSpec
  readonly pack: PathSpec
  readonly v2: boolean
  readonly fanout: DataView
  readonly count: number
  /** Each fanout bucket's names, read once asked. */
  readonly buckets: Map<number, Uint8Array>
  /** Every entry's offset in index order, read once asked. */
  offsets: number[] | null
  /** The same offsets sorted, then where the trailer starts. */
  ends: number[] | null
  readonly blocks: Blocks
}

/** A file read a block at a time, the last few blocks kept. */
export interface Blocks {
  readonly vfs: Files
  readonly path: PathSpec
  readonly kept: Map<number, Uint8Array>
}

/** Read `path` in blocks from here on. */
export function openBlocks(vfs: Files, path: PathSpec): Blocks {
  return { vfs, path, kept: new Map() }
}

/**
 * `length` bytes from `start`, out of whole blocks: the objects of a pack sit
 * side by side, so one read serves the many small ones a walk reaches in turn,
 * as git's mmap windows do. A read longer than a few blocks goes straight to
 * the file and keeps nothing; fewer bytes come back past the end.
 */
export async function readBlocks(
  blocks: Blocks,
  start: number,
  length: number,
): Promise<Uint8Array> {
  if (length > PACK_BLOCK * 4) return readRange(blocks.vfs, blocks.path, start, length)
  const out = new Uint8Array(length)
  let wrote = 0
  while (wrote < length) {
    const at = start + wrote
    const index = Math.floor(at / PACK_BLOCK)
    let block = blocks.kept.get(index)
    if (block === undefined) {
      block = await readRange(blocks.vfs, blocks.path, index * PACK_BLOCK, PACK_BLOCK)
      if (blocks.kept.size >= PACK_BLOCKS) {
        const oldest = blocks.kept.keys().next().value
        if (oldest !== undefined) blocks.kept.delete(oldest)
      }
    } else blocks.kept.delete(index)
    blocks.kept.set(index, block)
    const inside = at - index * PACK_BLOCK
    const piece = block.subarray(inside, inside + length - wrote)
    if (!piece.byteLength) break
    out.set(piece, wrote)
    wrote += piece.byteLength
  }
  return wrote === length ? out : out.subarray(0, wrote)
}

/**
 * What reading packed objects has learned in one invocation: each pack's
 * index tables, read a bucket at a time, and the objects lately resolved,
 * which delta chains reach again and again.
 */
export interface Packs {
  readonly vfs: Files
  readonly dir: PathSpec
  files: PackFile[] | null
  readonly resolved: Map<string, Packed>
  held: number
}

/** The packs of one object database, opened as reads need them. */
export function openPacks(vfs: Files, commondir: PathSpec): Packs {
  return { vfs, dir: commondir.join(PACK_DIR), files: null, resolved: new Map(), held: 0 }
}

/** zlib's inflate of one complete stream, its bytes exactly. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * `data` as a zlib stream of stored blocks: the bytes a loose object file
 * holds for an object, without the cost of compressing what is read once.
 */
export function storedZlib(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.byteLength / STORED_BLOCK))
  const out = new Uint8Array(2 + blocks * 5 + data.byteLength + 4)
  out[0] = 0x78
  out[1] = 0x01
  let at = 2
  for (let block = 0; block < blocks; block++) {
    const start = block * STORED_BLOCK
    const length = Math.min(STORED_BLOCK, data.byteLength - start)
    out[at] = block === blocks - 1 ? 1 : 0
    out[at + 1] = length & 0xff
    out[at + 2] = length >> 8
    out[at + 3] = ~length & 0xff
    out[at + 4] = (~length >> 8) & 0xff
    out.set(data.subarray(start, start + length), at + 5)
    at += 5 + length
  }
  let a = 1
  let b = 0
  for (let start = 0; start < data.byteLength; start += ADLER_RUN) {
    const end = Math.min(start + ADLER_RUN, data.byteLength)
    for (let i = start; i < end; i++) {
      a += data[i] ?? 0
      b += a
    }
    a %= ADLER_MOD
    b %= ADLER_MOD
  }
  new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0, false)
  return out
}

/** An object's bytes as git hashes and stores them: its header, then its content. */
export function wrapped(type: string, content: Uint8Array): Uint8Array {
  return concat([ENC.encode(`${type} ${String(content.byteLength)}\0`), content])
}

/**
 * Rebuild an object from a delta against its base, as git's patch-delta
 * does: the base's size, the result's, then copies out of the base and
 * literal inserts.
 */
export function applyDelta(delta: Uint8Array, base: Uint8Array): Uint8Array {
  let at = 0
  const next = (): number => {
    const byte = delta[at++]
    if (byte === undefined) throw new GitError('delta ends inside an instruction')
    return byte
  }
  const size = (): number => {
    let value = 0
    let shift = 0
    let byte: number
    do {
      byte = next()
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
    } while (byte & 0x80)
    return value
  }
  if (size() !== base.byteLength) throw new GitError('delta base size mismatch')
  const out = new Uint8Array(size())
  let wrote = 0
  while (at < delta.byteLength) {
    const op = next()
    if (op & 0x80) {
      let offset = 0
      let length = 0
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) offset += next() * 2 ** (8 * bit)
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) length += next() * 2 ** (8 * bit)
      if (length === 0) length = 0x10000
      if (offset + length > base.byteLength || wrote + length > out.byteLength)
        throw new GitError('delta copies past its base')
      out.set(base.subarray(offset, offset + length), wrote)
      wrote += length
    } else if (op !== 0) {
      if (at + op > delta.byteLength || wrote + op > out.byteLength)
        throw new GitError('delta inserts past its end')
      out.set(delta.subarray(at, at + op), wrote)
      at += op
      wrote += op
    } else throw new GitError('unexpected delta opcode 0')
  }
  if (wrote !== out.byteLength) throw new GitError('delta result size mismatch')
  return out
}

/** One entry's header: its kind, the length of the header, and its base if a delta. */
function entryHead(
  raw: Uint8Array,
  offset: number,
): { kind: number; at: number; base: number | string | null } {
  let at = 0
  let byte = raw[at++] ?? 0
  const kind = (byte >> 4) & 7
  while (byte & 0x80) byte = raw[at++] ?? 0
  if (kind === OFS_DELTA) {
    byte = raw[at++] ?? 0
    let back = byte & 0x7f
    while (byte & 0x80) {
      byte = raw[at++] ?? 0
      back = (back + 1) * 128 + (byte & 0x7f)
    }
    const base = offset - back
    if (base <= 0 || base >= offset)
      throw new GitError(
        `pack has bad object at offset ${String(offset)}: delta base offset is out of bound`,
      )
    return { kind, at, base }
  }
  if (kind === REF_DELTA)
    return { kind, at: at + SHA_BYTES, base: toHex(raw.subarray(at, at + SHA_BYTES)) }
  return { kind, at, base: null }
}

async function packFiles(packs: Packs): Promise<PackFile[]> {
  if (packs.files !== null) return packs.files
  const files: PackFile[] = []
  for (const entry of await readNames(packs.vfs, packs.dir)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const idx = packs.dir.join(name)
    const head = await readRange(packs.vfs, idx, 0, V2_HEADER + FANOUT_SIZE)
    const v2 = IDX_MAGIC.every((value, i) => head[i] === value)
    const table = head.subarray(v2 ? V2_HEADER : 0, (v2 ? V2_HEADER : 0) + FANOUT_SIZE)
    if (table.byteLength < FANOUT_SIZE) continue
    const fanout = new DataView(table.buffer, table.byteOffset, FANOUT_SIZE)
    files.push({
      idx,
      pack: packs.dir.join(`${name.slice(0, -IDX_SUFFIX.length)}.pack`),
      v2,
      fanout,
      count: fanout.getUint32(255 * 4, false),
      buckets: new Map(),
      offsets: null,
      ends: null,
      blocks: openBlocks(packs.vfs, packs.dir.join(`${name.slice(0, -IDX_SUFFIX.length)}.pack`)),
    })
  }
  packs.files = files
  return files
}

/** Where a pack stores an object, null when none of them does. */
async function locate(
  packs: Packs,
  oid: string,
): Promise<{ file: PackFile; offset: number } | null> {
  const want = fromHex(oid)
  const first = want[0] ?? 0
  for (const file of await packFiles(packs)) {
    const start = first === 0 ? 0 : file.fanout.getUint32((first - 1) * 4, false)
    const end = file.fanout.getUint32(first * 4, false)
    if (end <= start) continue
    const stride = file.v2 ? SHA_BYTES : V1_ENTRY
    const lead = file.v2 ? 0 : 4
    let names = file.buckets.get(first)
    if (names === undefined) {
      const base = (file.v2 ? V2_HEADER : 0) + FANOUT_SIZE
      names = await readRange(packs.vfs, file.idx, base + start * stride, (end - start) * stride)
      file.buckets.set(first, names)
    }
    let low = 0
    let high = end - start
    while (low < high) {
      const middle = (low + high) >> 1
      const at = middle * stride + lead
      let order = 0
      for (let i = 0; i < SHA_BYTES && order === 0; i++)
        order = (names[at + i] ?? 0) - (want[i] ?? 0)
      if (order === 0) {
        const offsets = await offsetTable(packs, file)
        return { file, offset: offsets[start + middle] ?? 0 }
      }
      if (order < 0) low = middle + 1
      else high = middle
    }
  }
  return null
}

/**
 * Every entry's offset in index order, the index's whole offset table read
 * once, with the sorted copy entry ends are found in.
 */
async function offsetTable(packs: Packs, file: PackFile): Promise<number[]> {
  if (file.offsets !== null) return file.offsets
  const offsets: number[] = []
  if (file.v2) {
    const tables = V2_HEADER + FANOUT_SIZE + file.count * (SHA_BYTES + 4)
    const small = await readRange(packs.vfs, file.idx, tables, file.count * 4)
    const view = new DataView(small.buffer, small.byteOffset, small.byteLength)
    const wide: number[] = []
    for (let i = 0; i < file.count; i++) {
      const value = view.getUint32(i * 4, false)
      offsets.push(value)
      if (value & LARGE) wide.push(value - LARGE)
    }
    if (wide.length) {
      const table = await readRange(
        packs.vfs,
        file.idx,
        tables + file.count * 4,
        (Math.max(...wide) + 1) * 8,
      )
      const big = new DataView(table.buffer, table.byteOffset, table.byteLength)
      offsets.forEach((value, i) => {
        if (!(value & LARGE)) return
        const slot = (value - LARGE) * 8
        offsets[i] = big.getUint32(slot, false) * 2 ** 32 + big.getUint32(slot + 4, false)
      })
    }
  } else {
    const table = await readRange(packs.vfs, file.idx, FANOUT_SIZE, file.count * V1_ENTRY)
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
    for (let i = 0; i < file.count; i++) offsets.push(view.getUint32(i * V1_ENTRY, false))
  }
  const size =
    (await statOf(packs.vfs, file.pack))?.size ??
    (await readOptional(packs.vfs, file.pack))?.byteLength ??
    0
  file.offsets = offsets
  file.ends = [...offsets].sort((a, b) => a - b)
  file.ends.push(size - SHA_BYTES)
  return offsets
}

/** Where the entry at `offset` ends: the next entry, or the trailer. */
async function entryEnd(packs: Packs, file: PackFile, offset: number): Promise<number> {
  await offsetTable(packs, file)
  const ends = file.ends ?? []
  let low = 0
  let high = ends.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if ((ends[middle] ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  return ends[low] ?? offset
}

function remember(packs: Packs, key: string, object: Packed): void {
  if (object.content.byteLength > PACK_CACHE_BYTES / 4) return
  packs.resolved.set(key, object)
  packs.held += object.content.byteLength
  for (const [old, kept] of packs.resolved) {
    if (packs.held <= PACK_CACHE_BYTES) break
    packs.resolved.delete(old)
    packs.held -= kept.content.byteLength
  }
}

/** The object stored at `offset`, its deltas applied. */
async function readAt(packs: Packs, file: PackFile, offset: number): Promise<Packed> {
  const key = `${file.pack.virtual}:${String(offset)}`
  const cached = packs.resolved.get(key)
  if (cached !== undefined) {
    packs.resolved.delete(key)
    packs.resolved.set(key, cached)
    return cached
  }
  const end = await entryEnd(packs, file, offset)
  const raw = await readBlocks(file.blocks, offset, end - offset)
  const { kind, at, base } = entryHead(raw, offset)
  const data = await inflate(raw.subarray(at))
  let object: Packed
  if (base === null) {
    const type = KINDS[kind - 1]
    if (type === undefined)
      throw new GitError(
        `unknown object type ${String(kind)} at offset ${String(offset)} in ${file.pack.virtual}`,
      )
    object = { type, content: data }
  } else {
    const parent =
      typeof base === 'number' ? await readAt(packs, file, base) : await anyObject(packs, base)
    if (parent === null) throw new GitError(`failed to read delta base object ${String(base)}`)
    object = { type: parent.type, content: applyDelta(data, parent.content) }
  }
  remember(packs, key, object)
  return object
}

/** An object from the packs, or else loose: a reference delta's base may be either. */
async function anyObject(packs: Packs, oid: string): Promise<Packed | null> {
  const packed = await packedObject(packs, oid)
  if (packed !== null) return packed
  const stored = await readOptional(
    packs.vfs,
    packs.dir.parent.join(`${oid.slice(0, 2)}/${oid.slice(2)}`),
  )
  if (stored === null) return null
  const raw = await inflate(stored)
  const space = raw.indexOf(0x20)
  const nul = raw.indexOf(0)
  return { type: DEC.decode(raw.subarray(0, space)), content: raw.subarray(nul + 1) }
}

/**
 * One object out of the packs, null when none holds it. Only the index
 * bucket its id falls in, its offset and its own entry are read, then each
 * base a delta names, where git maps the whole pack.
 */
export async function packedObject(packs: Packs, oid: string): Promise<Packed | null> {
  const found = await locate(packs, oid)
  return found === null ? null : readAt(packs, found.file, found.offset)
}

/**
 * An object's entry as its pack stores it, header and compressed data, which a
 * pack built from this one carries as it is, as git's pack-objects reuses one.
 * Null for a delta, which the receiver would have to rebuild (costing it what
 * the reuse saves), or an object no pack holds.
 */
export async function storedEntry(packs: Packs, oid: string): Promise<Uint8Array | null> {
  const found = await locate(packs, oid)
  if (found === null) return null
  const end = await entryEnd(packs, found.file, found.offset)
  const raw = await readBlocks(found.file.blocks, found.offset, end - found.offset)
  return entryHead(raw, found.offset).base === null ? raw : null
}

/** Whether a pack holds an object, reading only its index. */
export async function holdsPacked(packs: Packs, oid: string): Promise<boolean> {
  return (await locate(packs, oid)) !== null
}

/** The fields of one line of isomorphic-git's parsed config that a raw read needs. */
export interface ConfigLine {
  readonly path: string
  readonly name: string | null
  readonly value: string | null
}

/** A parsed line as isomorphic-git leaves it, its subsection still escaped. */
interface ParsedLine extends ConfigLine {
  readonly section: string | null
  readonly subsection?: string | null
}

/**
 * The lines that hold a variable, each keyed the way git reads it.
 *
 * isomorphic-git keeps a quoted subsection's escapes, so `[branch "q\"x"]`
 * came back as `branch.q\"x.remote` and a lookup for the branch `q"x` found
 * nothing; git drops the backslash before any character.
 */
function variables(parsed: readonly ParsedLine[]): ConfigLine[] {
  return parsed
    .filter((line) => line.name !== null)
    .map((line) => {
      const { section, subsection, name } = line
      if (typeof subsection !== 'string' || section === null || name === null) return line
      const unescaped = subsection.replace(/\\(.)/g, '$1')
      return { ...line, path: `${section.toLowerCase()}.${unescaped}.${name.toLowerCase()}` }
    })
}

/**
 * The variables of one config file's text, in file order, as isomorphic-git
 * parses them: `path` is the dotted key, section and name folded, and `value`
 * the raw string git prints. Read from text rather than a git directory
 * because `--global` names files that are not called `config`.
 *
 * @param text the file's contents
 */
export async function configLines(text: string): Promise<readonly ConfigLine[]> {
  const config = await GitConfigManager.get({
    fs: { read: () => Promise.resolve(text) } as never,
    gitdir: '',
  })
  return variables(config.parsedConfig as readonly ParsedLine[])
}

/**
 * The stat shape isomorphic-git reads. It consults `type`, `mode`, `size` and
 * the mtime, and calls `isDirectory()`/`isFile()`/`isSymbolicLink()`; the
 * numeric device fields feed its index stat cache, which mirage zeroes on
 * purpose so nothing downstream trusts it (see IndexEntry in types.ts).
 */
class GitStat {
  readonly type: 'file' | 'dir'
  readonly mode: number
  readonly size: number
  readonly ino = 0
  readonly dev = 0
  readonly uid = 0
  readonly gid = 0
  readonly ctimeMs: number
  readonly mtimeMs: number
  readonly ctimeSeconds: number
  readonly mtimeSeconds: number
  readonly ctimeNanoseconds = 0
  readonly mtimeNanoseconds = 0

  constructor(stat: FileStat) {
    const dir = stat.type === FileType.DIRECTORY
    this.type = dir ? 'dir' : 'file'
    this.mode = stat.mode ?? (dir ? 0o040755 : 0o100644)
    this.size = stat.size ?? 0
    const ms = stat.modified === null ? 0 : Date.parse(stat.modified) || 0
    this.ctimeMs = ms
    this.mtimeMs = ms
    this.ctimeSeconds = Math.floor(ms / 1000)
    this.mtimeSeconds = Math.floor(ms / 1000)
  }

  isDirectory(): boolean {
    return this.type === 'dir'
  }

  isFile(): boolean {
    return this.type === 'file'
  }

  isSymbolicLink(): boolean {
    return false
  }
}

/**
 * A `PromiseFsClient` whose bytes come from a mirage mount.
 *
 * isomorphic-git reaches a repository through nothing but this object, so a
 * repository on S3, in RAM or over SSH is the same repository to it. That is
 * the whole bridge, and it is why the TypeScript side needs no counterpart to
 * Python's `objects.py`/`lazyfile.py`: dulwich's object store is synchronous, so
 * Python has to hand-build a lazy store and marshal every read onto the
 * workspace loop, while isomorphic-git is async to begin with and reads loose
 * objects and the index itself.
 *
 * Packs are the exception. isomorphic-git reads a whole packfile into memory,
 * and hashes all of it, to pull one object out, so the bridge keeps the pack
 * indexes from it and answers for a packed object as for the loose file it
 * would be: its index bucket, its offset and its own entry are read, its
 * deltas applied (`pack.ts`), and the bytes handed over as stored zlib blocks.
 *
 * Symlinks are refused rather than faked. mirage keeps links in the namespace
 * rather than in any backend, so a `readlink` here would have to consult a
 * different layer than every other call, and no verb mirrored so far writes or
 * follows one inside a `.git` directory.
 */
export function gitFs(
  source: Files,
  location?: RepoLocation,
): {
  promises: Record<string, (...args: never[]) => Promise<unknown>>
} {
  // isomorphic-git accepts one gitdir and does not follow commondir itself.
  // Route shared storage here so every library operation keeps the selected
  // checkout's HEAD/index while using the common objects, refs and config.
  const roots =
    location === undefined
      ? []
      : [location.gitdir, location.commondir, location.worktree].sort(
          (a, b) => b.virtual.length - a.virtual.length,
        )
  const route = (path: string): PathSpec => {
    const spec = PathSpec.fromStrPath(path)
    if (location === undefined) return spec
    const virtual = posixNormpath(spec.virtual)
    for (const root of roots) {
      const prefix = `${root.virtual.replace(/\/$/, '')}/`
      if (virtual !== root.virtual && !virtual.startsWith(prefix)) continue
      const relative = virtual === root.virtual ? '' : virtual.slice(prefix.length)
      const shared = ['objects', 'refs', 'packed-refs', 'config', 'shallow'].some(
        (name) => relative === name || relative.startsWith(`${name}/`),
      )
      const local = ['refs/bisect', 'refs/worktree', 'refs/rewritten'].some(
        (name) => relative === name || relative.startsWith(`${name}/`),
      )
      const base = root === location.gitdir && shared && !local ? location.commondir : root
      return relative ? base.join(relative) : base
    }
    return spec
  }

  const packs = location === undefined ? null : openPacks(source, location.commondir)
  const packDir = location?.commondir.join(PACK_DIR).virtual ?? null

  const readFile = async (path: string, options?: string | { encoding?: string }) => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const target = route(path)
    let bytes: Uint8Array
    try {
      bytes = await source.read(target)
    } catch (err) {
      const loose = packs === null || !isMissingPath(err) ? null : LOOSE.exec(target.virtual)
      if (loose === null || packs === null) throw err
      let packed: Packed | null
      try {
        packed = await packedObject(packs, `${loose[1] ?? ''}${loose[2] ?? ''}`)
      } catch (failure) {
        // isomorphic-git drops a readFile error and then looks in the packs it
        // cannot see, so an unreadable packed object would come out as a
        // missing one. Bytes that do not inflate fail it as a corrupt loose
        // object does.
        console.debug('packed object unreadable:', failure)
        return encoding === undefined ? UNREADABLE : ''
      }
      if (packed === null) throw err
      bytes = storedZlib(wrapped(packed.type, packed.content))
    }
    return encoding === undefined ? bytes : DEC.decode(bytes)
  }

  const writeFile = async (path: string, data: Uint8Array | string) => {
    await writePath(source, route(path), typeof data === 'string' ? ENC.encode(data) : data)
  }

  const stat = async (path: string) => new GitStat(await source.stat(route(path)))

  return {
    promises: {
      readFile,
      writeFile,
      unlink: async (path: string) => {
        await removeFile(source, route(path))
      },
      // isomorphic-git wants bare names; backends may report either those or
      // whole paths, with or without a trailing slash.
      // The pack indexes stay out of isomorphic-git's sight, so it never
      // loads a pack; readFile and exists answer for what they hold.
      readdir: async (path: string) => {
        const target = route(path)
        const names = (await readNames(source, target)).map(entryName)
        return target.virtual === packDir
          ? names.filter((name) => !name.endsWith(IDX_SUFFIX))
          : names
      },
      mkdir: async (path: string) => {
        await ensureDir(source, route(path))
      },
      rmdir: async (path: string) => {
        await source.rmdir(route(path))
      },
      stat,
      // A mount has no links below it, so lstat is stat.
      lstat: stat,
      readlink: () => Promise.reject(new Error('mirage git: symlinks are not read here')),
      symlink: () => Promise.reject(new Error('mirage git: symlinks are not written here')),
      // git chmods a loose object to 0444; the mount decides its own modes and
      // writeOnce never rewrites one, so there is nothing to enforce.
      chmod: () => Promise.resolve(),
      exists: async (path: string) => {
        const target = route(path)
        if (await exists(source, target)) return true
        const loose = packs === null ? null : LOOSE.exec(target.virtual)
        return (
          loose !== null &&
          packs !== null &&
          (await holdsPacked(packs, `${loose[1] ?? ''}${loose[2] ?? ''}`))
        )
      },
    } as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
  }
}

/**
 * Every value a variable takes in the repository's config, as written.
 *
 * Read below `git.getConfig`, which casts `core.bare` and a few other keys
 * itself, and only when they are spelled in lowercase and hold a word:
 * `[Core] Bare = true` came back a string and `bare = 1` threw. A linked
 * worktree's config is its repository's.
 *
 * @param vfs the session's files
 * @param location the discovered repository
 * @param path the variable, e.g. `core.bare`; its section and name in any case
 */
export async function configValues(
  vfs: Files,
  location: RepoLocation,
  path: string,
): Promise<string[]> {
  const config = await GitConfigManager.get({
    fs: new FileSystem(gitFs(vfs, location)) as never,
    gitdir: location.commondir.virtual,
  })
  // Section and name fold case; a subsection between them does not.
  const first = path.indexOf('.')
  const last = path.lastIndexOf('.')
  const key =
    path.slice(0, first).toLowerCase() + path.slice(first, last) + path.slice(last).toLowerCase()
  const inFile = variables(config.parsedConfig as readonly ParsedLine[])
    .filter((line) => line.path === key)
    .map((line) => line.value ?? '')
  const typed = (location.overrides ?? [])
    .filter(([name]) => name === key)
    .map(([, value]) => value ?? 'true')
  return [...inFile, ...typed]
}

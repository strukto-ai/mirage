import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { getExtension } from '../utils/filetype.ts'
import { isEnoent, isStaleWrite } from '../errors/fs.ts'
import { classify } from '../errors/classify.ts'
import { runWithWriteContext } from '../cache/context.ts'
import { ABSENT_WRITE, OwnRead } from '../cache/types.ts'
import type {
  ConditionMode,
  Measured,
  WriteCondition,
  WriteContext,
  WriteKind,
} from '../cache/types.ts'
import type { FileStat } from '../types.ts'
import { DirListing, FileType, PathSpec } from '../types.ts'
import { mountPrefixOf } from '../utils/key_prefix.ts'
import type { BaseVFS } from './base.ts'
import type { Handed } from './types.ts'
import type { ByteSource } from '../io/types.ts'
import { concat } from '../utils/bytes.ts'
import { rstripSlash } from '../utils/slash.ts'

/** A known file, its parent and absent sibling, and an optional chunk bound. */
export interface ReadFixture {
  file: PathSpec
  directory: PathSpec
  missing: PathSpec
  content: Uint8Array
  maxChunkSize?: number
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i])
}

// The renderer a read of `path` runs, found by the extension the mount
// resolves it by, or undefined where the VFS renders none. Mirrors
// Python's `_renderer`.
function renderer(vfs: BaseVFS, path: PathSpec): BaseVFS['read'] | undefined {
  const name = vfs.renderers[getExtension(path.virtual) ?? '']
  if (name === undefined) return undefined
  const render = (vfs as unknown as Record<string, BaseVFS['read'] | undefined>)[name]
  check(render !== undefined, `renderer ${name} is not a method`)
  return render.bind(vfs)
}

// What a VFS function is handed beside its path, as the mount hands it: the
// store, for a function that takes one, what is at its path, and its
// folder's row. Mirrors Python's `_taken`.
function taken(
  store: IndexCacheStore,
  found: FileStat | null,
  parent: FileStat | null = null,
): Handed {
  return { index: store, entry: found, parent }
}

// What is at `path` and at its folder, found by listing each directory from
// the mount root down, each handed what its own parent's listing named, as
// the mount finds it. Null for the root, which no listing names, and for a
// path nothing is at. Mirrors Python's `_rows_at`.
async function rowsAt(vfs: BaseVFS, path: PathSpec): Promise<[FileStat | null, FileStat | null]> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const names = path.vfsPath.split('/').filter((name) => name !== '')
  let found: FileStat | null = null
  let above: FileStat | null = null
  for (const [depth, name] of names.entries()) {
    const key = names.slice(0, depth).join('/')
    const virtual = key !== '' ? `${prefix}/${key}` : prefix || '/'
    const folder = new PathSpec({ virtual, directory: virtual, vfsPath: key })
    const listed = await vfs.readdir(folder, { entry: found, parent: above })
    const rows = listed instanceof DirListing ? listed.entries : listed
    above = found
    found = rows.find((row) => row.name === name) ?? null
    if (found === null) return [null, above]
  }
  return [found, above]
}

/**
 * What a `read` answered, a stream collected and each of its chunks held to
 * `maxChunkSize`. Mirrors Python's `_bytes_of`.
 */
async function bytesOf(
  answer: Promise<ByteSource> | AsyncIterable<Uint8Array>,
  maxChunkSize?: number,
): Promise<Uint8Array> {
  const found = await answer
  if (found instanceof Uint8Array) return found
  const chunks: Uint8Array[] = []
  for await (const chunk of found) {
    check(
      maxChunkSize === undefined || chunk.byteLength <= maxChunkSize,
      'read streamed a chunk over maxChunkSize',
    )
    chunks.push(chunk)
  }
  return concat(chunks)
}

// Check that `read` answers a byte window of `data`, the whole file as
// `read` answers it. Mirrors Python's `_check_windows`.
async function checkWindows(
  read: BaseVFS['read'],
  path: PathSpec,
  slot: Handed,
  data: Uint8Array,
): Promise<void> {
  if (data.length === 0) return
  const offset = Math.min(1, data.length - 1)
  for (const size of [Math.min(3, data.length - offset), null]) {
    const actual = await bytesOf(read(path, slot, offset, size))
    check(
      sameBytes(actual, data.slice(offset, size === null ? undefined : offset + size)),
      'read must use offset and byte count',
    )
  }
}

/**
 * Verify a VFS's reads against a caller-owned fixture, mutating nothing.
 *
 * A read runs the renderer of the file's filetype where the VFS renders
 * one, else `read`; a read that answers a stream is collected, each chunk
 * held to the fixture's bound, and a missing file may fail when it is called
 * or at its first pull. An existence check is probed only where the VFS
 * defines one. A renderer is always handed a byte window, `read` only where
 * it takes one natively: the caller reads whole and slices otherwise. `index` is the store every function is
 * handed, a RAM store at the VFS's `indexTtl` by default. Mirrors Python's
 * `check_read_contract`.
 */
export async function checkReadContract(
  vfs: BaseVFS,
  fixture: ReadFixture,
  index?: IndexCacheStore,
): Promise<void> {
  const store = index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl })
  const [entry, folderRow] = await rowsAt(vfs, fixture.file)
  const [, above] = await rowsAt(vfs, fixture.directory)
  const file = taken(store, entry, folderRow)
  const folder = taken(store, folderRow, above)
  const render = renderer(vfs, fixture.file)
  const data = await bytesOf(
    (render ?? vfs.read.bind(vfs))(fixture.file, file),
    fixture.maxChunkSize,
  )
  check(sameBytes(data, fixture.content), 'read differs from fixture content')
  const info = await vfs.stat(fixture.file, file)
  check(info.type === FileType.FILE, 'fixture must stat as a file')
  check(
    info.size === null || info.size === data.length,
    'stat size must be rendered byte length or null',
  )
  const parent = await vfs.stat(fixture.directory, folder)
  check(parent.type === FileType.DIRECTORY, 'parent must stat as a directory')
  const listed = await vfs.readdir(fixture.directory, folder)
  const rows = listed instanceof DirListing ? listed.entries : listed
  const child = rstripSlash(fixture.file.virtual).split('/').pop() ?? ''
  check(
    rows.some((row) => row.name === child),
    'readdir must include the child',
  )
  const stored =
    render !== undefined && vfs.supports('read')
      ? await bytesOf(vfs.read(fixture.file, file), fixture.maxChunkSize)
      : data
  if (render !== undefined) await checkWindows(render, fixture.file, file, data)
  if (vfs.readsRanges && vfs.supports('read')) {
    await checkWindows(vfs.read.bind(vfs), fixture.file, file, stored)
  }
  const missing = taken(store, null, folderRow)
  if (vfs.supports('exists')) {
    check(await vfs.exists(fixture.file, file), 'exists rejected the fixture file')
    check(!(await vfs.exists(fixture.missing, missing)), 'exists accepted a missing file')
  }
  const readMissing = renderer(vfs, fixture.missing) ?? vfs.read.bind(vfs)
  for (const call of [
    (p: PathSpec) => vfs.stat(p, missing),
    (p: PathSpec) => bytesOf(readMissing(p, missing)),
  ]) {
    try {
      await call(fixture.missing)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    throw new Error('missing paths must raise ENOENT')
  }
}

/**
 * An empty, caller-owned scratch directory the check writes its files in,
 * and the bytes it seeds them with. Mirrors Python's `MutationFixture`.
 */
export interface MutationFixture {
  directory: PathSpec
  content?: Uint8Array
}

const OTHER = new TextEncoder().encode('replaced\n')
const LOST = '0'.repeat(32)

// The file `name` in `directory`, keyed below the same mount. Mirrors
// Python's `_child`.
function child(directory: PathSpec, name: string): PathSpec {
  const key = `${directory.vfsPath.replace(/^\/+|\/+$/g, '')}/${name}`.replace(/^\/+/, '')
  return new PathSpec({
    virtual: `${rstripSlash(directory.virtual)}/${name}`,
    directory: directory.virtual,
    vfsPath: key,
  })
}

// A write context holding one version per path, as a conditional mount's
// cache would after the session read it. Mirrors Python's `_Pinned`.
class Pinned {
  readonly versions = new Map<string, Measured>()

  constructor(private readonly vfs: BaseVFS) {}

  context(): WriteContext {
    const support = Object.entries(this.vfs.conditionSupport) as [WriteKind, ConditionMode[]][]
    return {
      vfs: this.vfs.name,
      conditions: support.filter(([, modes]) => modes.includes('match')).map(([kind]) => kind),
      creates: support.filter(([, modes]) => modes.includes('absent')).map(([kind]) => kind),
      readVersion: (path) => Promise.resolve(this.versions.get(path.virtual) ?? null),
      readVersions: (paths) =>
        Promise.resolve(paths.map((path) => this.versions.get(path.virtual) ?? null)),
      drop: (path) => {
        this.versions.delete(path.virtual)
        return Promise.resolve()
      },
      keep: (path, version) => {
        this.versions.set(path.virtual, version)
        return Promise.resolve()
      },
    }
  }

  run(path: PathSpec, fn: () => Promise<unknown>): Promise<unknown> {
    return runWithWriteContext(mountPrefixOf(path.virtual, path.vfsPath), this.context(), fn)
  }
}

async function rejects(
  call: () => Promise<unknown>,
  wanted: (error: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await call()
  } catch (error) {
    if (wanted(error)) return
    throw error
  }
  throw new Error(message)
}

// One mutation-contract run: the VFS, its store, and the scratch
// directory's files. Mirrors Python's `_Checker`.
class Checker {
  readonly content: Uint8Array

  constructor(
    private readonly vfs: BaseVFS,
    private readonly fixture: MutationFixture,
    private readonly store: IndexCacheStore,
  ) {
    this.content = fixture.content ?? new TextEncoder().encode('mutation contract\n')
  }

  path(name: string): PathSpec {
    return child(this.fixture.directory, name)
  }

  get handed(): Handed {
    return taken(this.store, null)
  }

  async put(path: PathSpec, data: Uint8Array): Promise<void> {
    await this.vfs.write(path, data, undefined, this.handed)
  }

  bytesAt(path: PathSpec): Promise<Uint8Array> {
    return bytesOf(this.vfs.read(path, this.handed))
  }

  async gone(path: PathSpec): Promise<boolean> {
    try {
      await this.vfs.stat(path, this.handed)
    } catch (error) {
      if (isEnoent(error)) return true
      throw error
    }
    return false
  }

  async version(path: PathSpec): Promise<string> {
    const info = await this.vfs.stat(path, this.handed)
    check(
      info.fingerprint !== null && info.fingerprint !== '',
      'a VFS that declares a match condition must stat a fingerprint',
    )
    return info.fingerprint
  }

  call(op: 'rename' | 'copy' | 'unlink', ...paths: PathSpec[]): Promise<unknown> {
    const [first, second] = paths as [PathSpec, PathSpec]
    if (op === 'rename') return this.vfs.rename(first, second, this.handed)
    if (op === 'copy') return this.vfs.copy(first, second, undefined, this.handed)
    return this.vfs.unlink(first, this.handed)
  }

  // Check `rename` or `copy` of one file: onto a fresh name, onto an
  // existing file, and from a missing source.
  async checkMoved(op: 'rename' | 'copy'): Promise<void> {
    const src = this.path(`${op}-src`)
    const dst = this.path(`${op}-dst`)
    for (const existing of [false, true]) {
      await this.put(src, this.content)
      if (existing) await this.put(dst, OTHER)
      await this.call(op, src, dst)
      check(
        sameBytes(await this.bytesAt(dst), this.content),
        `${op} must land the source's bytes${existing ? ' over an existing file' : ''}`,
      )
      if (op === 'rename') check(await this.gone(src), 'rename must remove the source')
      else check(sameBytes(await this.bytesAt(src), this.content), 'copy must keep the source')
    }
    await rejects(
      () => this.call(op, this.path(`${op}-missing`), dst),
      isEnoent,
      `${op} of a missing source must raise ENOENT`,
    )
    check(
      sameBytes(await this.bytesAt(dst), this.content),
      `a refused ${op} must leave the destination`,
    )
  }

  // Check a conditional replace: honoured and refused when declared,
  // refused unsupported, writing nothing, when not.
  async checkPut(mode: ConditionMode, declared: boolean): Promise<void> {
    const path = this.path(`put-${mode}`)
    if (mode === 'match' || !declared) await this.put(path, OTHER)
    const held: WriteCondition =
      mode === 'absent'
        ? ABSENT_WRITE
        : {
            kind: 'match',
            version: declared ? await this.version(path) : LOST,
          }
    const lost: WriteCondition = mode === 'absent' ? ABSENT_WRITE : { kind: 'match', version: LOST }
    if (!declared) {
      await rejects(
        () => this.vfs._replace({ path, body: this.content, condition: held }),
        (error) => classify(error) === 'ENOTSUP',
        `an undeclared put (${mode}) must raise ENOTSUP`,
      )
      check(
        sameBytes(await this.bytesAt(path), OTHER),
        `an undeclared put (${mode}) must write nothing`,
      )
      return
    }
    await this.vfs._replace({ path, body: this.content, condition: held })
    check(sameBytes(await this.bytesAt(path), this.content), `a held put (${mode}) must land`)
    await rejects(
      () => this.vfs._replace({ path, body: OTHER, condition: lost }),
      isStaleWrite,
      `a lost put (${mode}) must raise a stale write`,
    )
    check(
      sameBytes(await this.bytesAt(path), this.content),
      `a lost put (${mode}) must write nothing`,
    )
  }

  // Check a declared conditional copy, honoured and refused.
  async checkCopy(mode: ConditionMode): Promise<void> {
    const src = this.path(`copy-${mode}-src`)
    const dst = this.path(`copy-${mode}`)
    await this.put(src, this.content)
    if (mode === 'match') await this.put(dst, OTHER)
    const pinned = new Pinned(this.vfs)
    pinned.versions.set(dst.virtual, mode === 'absent' ? OwnRead.ABSENT : await this.version(dst))
    await pinned.run(dst, () => this.call('copy', src, dst))
    check(sameBytes(await this.bytesAt(dst), this.content), `a held copy (${mode}) must land`)
    await this.put(src, OTHER)
    pinned.versions.set(dst.virtual, mode === 'absent' ? OwnRead.ABSENT : LOST)
    await rejects(
      () => pinned.run(dst, () => this.call('copy', src, dst)),
      isStaleWrite,
      `a lost copy (${mode}) must raise a stale write`,
    )
    check(
      sameBytes(await this.bytesAt(dst), this.content),
      `a lost copy (${mode}) must write nothing`,
    )
  }

  // Check a declared conditional delete (match), honoured and refused.
  async checkDelete(): Promise<void> {
    const path = this.path('delete-match')
    await this.put(path, this.content)
    const pinned = new Pinned(this.vfs)
    pinned.versions.set(path.virtual, LOST)
    await rejects(
      () => pinned.run(path, () => this.call('unlink', path)),
      isStaleWrite,
      'a lost delete (match) must raise a stale write',
    )
    check(
      sameBytes(await this.bytesAt(path), this.content),
      'a lost delete (match) must keep the file',
    )
    pinned.versions.set(path.virtual, await this.version(path))
    await pinned.run(path, () => this.call('unlink', path))
    check(await this.gone(path), 'a held delete (match) must remove')
  }
}

/**
 * Verify a VFS's single-file mutations in an empty, caller-owned scratch
 * directory, leaving the files it wrote there.
 *
 * `rename` and `copy` are checked where the VFS defines them: onto a fresh
 * name and over an existing file the destination holds the source's bytes,
 * `rename` removes the source and `copy` keeps it, and a missing source
 * rejects ENOENT and leaves the destination. Write preconditions are checked
 * exactly as `conditionSupport` declares them, under the write context a
 * `write: conditional` mount binds: a declared condition lands when it holds
 * and rejects as a stale write, writing nothing, when it does not. An
 * undeclared put condition must reject ENOTSUP and write nothing; an
 * undeclared copy or delete condition is refused by the mount before the VFS
 * sees it, so it is not probed. `index` is the store every function is
 * handed, a RAM store at the VFS's `indexTtl` by default. Mirrors Python's
 * `check_mutation_contract`.
 */
export async function checkMutationContract(
  vfs: BaseVFS,
  fixture: MutationFixture,
  index?: IndexCacheStore,
): Promise<void> {
  check(vfs.supports('write'), 'the mutation contract seeds through write')
  const checker = new Checker(vfs, fixture, index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl }))
  for (const op of ['rename', 'copy'] as const) {
    if (vfs.supports(op)) await checker.checkMoved(op)
  }
  const support = vfs.conditionSupport
  for (const mode of ['absent', 'match'] as const) {
    await checker.checkPut(mode, (support.put ?? []).includes(mode))
  }
  if (vfs.supports('copy')) {
    for (const mode of support.copy ?? []) await checker.checkCopy(mode)
  }
  if (vfs.supports('unlink') && (support.delete ?? []).includes('match'))
    await checker.checkDelete()
}

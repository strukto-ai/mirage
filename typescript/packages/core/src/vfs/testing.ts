import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { getExtension } from '../utils/filetype.ts'
import { isEnoent, isStaleWrite } from '../errors/fs.ts'
import { runWithWriteContext } from '../cache/context.ts'
import { OwnRead } from '../cache/types.ts'
import type { ConditionMode, Measured, WriteContext, WriteKind } from '../cache/types.ts'
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

// Check that `call` rejects with what `wanted` accepts, letting any other
// rejection through. Mirrors Python's `_rejects`.
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

/**
 * Run `fn` under the write context a `write: conditional` mount of `vfs`
 * binds, its cache holding `versions`.
 *
 * Each pair is a path and the version a session read there, null for a
 * path it found no file at. A write, copy or delete of a listed path then
 * carries the condition `conditionSupport` declares for it: `match` on the
 * version, `absent` on null; an unlisted path goes out unconditioned.
 * Mirrors Python's `run_with_versions`.
 */
export function runWithVersions<T>(
  vfs: BaseVFS,
  versions: readonly (readonly [PathSpec, string | null])[],
  fn: () => Promise<T>,
): Promise<T> {
  const held = new Map<string, Measured>(
    versions.map(([path, version]) => [path.virtual, version ?? OwnRead.ABSENT]),
  )
  const support = Object.entries(vfs.conditionSupport) as [WriteKind, ConditionMode[]][]
  const context: WriteContext = {
    vfs: vfs.name,
    conditions: support.filter(([, modes]) => modes.includes('match')).map(([kind]) => kind),
    creates: support.filter(([, modes]) => modes.includes('absent')).map(([kind]) => kind),
    readVersion: (path) => Promise.resolve(held.get(path.virtual) ?? null),
    readVersions: (paths) => Promise.resolve(paths.map((path) => held.get(path.virtual) ?? null)),
    drop: (path) => {
      held.delete(path.virtual)
      return Promise.resolve()
    },
    keep: (path, version) => {
      held.set(path.virtual, version)
      return Promise.resolve()
    },
  }
  const [first] = versions
  const prefix = first === undefined ? '' : mountPrefixOf(first[0].virtual, first[0].vfsPath)
  return runWithWriteContext(prefix, context, fn)
}

// One mutation-contract run: the VFS, its store, and the files it wrote in
// the scratch directory. Mirrors Python's `_Checker`.
class Checker {
  readonly content: Uint8Array
  readonly written = new Map<string, PathSpec>()

  constructor(
    private readonly vfs: BaseVFS,
    private readonly fixture: MutationFixture,
    private readonly store: IndexCacheStore,
  ) {
    this.content = fixture.content ?? new TextEncoder().encode('mutation contract\n')
  }

  path(name: string): PathSpec {
    const path = child(this.fixture.directory, name)
    this.written.set(path.virtual, path)
    return path
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

  // Unlink every file the run named that is still there. A cleanup failure
  // after a failed run is logged, so the run's own failure is the one thrown.
  async clean(failed: boolean): Promise<void> {
    if (!this.vfs.supports('unlink')) return
    for (const path of this.written.values()) {
      try {
        await this.call('unlink', path)
      } catch (error) {
        if (isEnoent(error)) continue
        if (!failed) throw error
        console.debug(`cleanup of ${path.virtual} failed: ${String(error)}`)
      }
    }
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
    check(sameBytes(await this.bytesAt(dst), this.content), `a refused ${op} must leave the destination`)
  }

  // Check a declared conditional write, honoured and refused.
  async checkPut(mode: ConditionMode): Promise<void> {
    const path = this.path(`put-${mode}`)
    if (mode === 'match') await this.put(path, OTHER)
    const held = mode === 'absent' ? null : await this.version(path)
    await runWithVersions(this.vfs, [[path, held]], () => this.put(path, this.content))
    check(sameBytes(await this.bytesAt(path), this.content), `a held put (${mode}) must land`)
    const lost = mode === 'absent' ? null : LOST
    await rejects(
      () => runWithVersions(this.vfs, [[path, lost]], () => this.put(path, OTHER)),
      isStaleWrite,
      `a lost put (${mode}) must raise a stale write`,
    )
    check(sameBytes(await this.bytesAt(path), this.content), `a lost put (${mode}) must write nothing`)
  }

  // Check a declared conditional copy, honoured and refused.
  async checkCopy(mode: ConditionMode): Promise<void> {
    const src = this.path(`copy-${mode}-src`)
    const dst = this.path(`copy-${mode}`)
    await this.put(src, this.content)
    if (mode === 'match') await this.put(dst, OTHER)
    const held = mode === 'absent' ? null : await this.version(dst)
    await runWithVersions(this.vfs, [[dst, held]], () => this.call('copy', src, dst))
    check(sameBytes(await this.bytesAt(dst), this.content), `a held copy (${mode}) must land`)
    await this.put(src, OTHER)
    const lost = mode === 'absent' ? null : LOST
    await rejects(
      () => runWithVersions(this.vfs, [[dst, lost]], () => this.call('copy', src, dst)),
      isStaleWrite,
      `a lost copy (${mode}) must raise a stale write`,
    )
    check(sameBytes(await this.bytesAt(dst), this.content), `a lost copy (${mode}) must write nothing`)
  }

  // Check a declared conditional delete (match), honoured and refused.
  async checkDelete(): Promise<void> {
    const path = this.path('delete-match')
    await this.put(path, this.content)
    await rejects(
      () => runWithVersions(this.vfs, [[path, LOST]], () => this.call('unlink', path)),
      isStaleWrite,
      'a lost delete (match) must raise a stale write',
    )
    check(sameBytes(await this.bytesAt(path), this.content), 'a lost delete (match) must keep the file')
    const held = await this.version(path)
    await runWithVersions(this.vfs, [[path, held]], () => this.call('unlink', path))
    check(await this.gone(path), 'a held delete (match) must remove')
  }

  // Check every declared condition, then `rename` and `copy`.
  async run(unenforced: readonly (readonly [WriteKind, ConditionMode])[]): Promise<void> {
    const support = this.vfs.conditionSupport
    const skipped = (kind: WriteKind, mode: ConditionMode): boolean =>
      unenforced.some(([k, m]) => k === kind && m === mode)
    for (const [kind, mode] of unenforced) {
      check(
        (support[kind] ?? []).includes(mode),
        `unenforced names ${kind} (${mode}), which the VFS does not declare`,
      )
      console.warn(`mutation contract: ${kind} (${mode}) skipped as unenforced`)
    }
    for (const kind of ['put', 'copy', 'delete'] as const) {
      for (const mode of ['absent', 'match'] as const) {
        if (skipped(kind, mode) || !(support[kind] ?? []).includes(mode)) continue
        if (kind === 'put') await this.checkPut(mode)
        else if (kind === 'copy' && this.vfs.supports('copy')) await this.checkCopy(mode)
        else if (kind === 'delete' && mode === 'match') await this.checkDelete()
      }
    }
    for (const op of ['rename', 'copy'] as const) {
      if (this.vfs.supports(op)) await this.checkMoved(op)
    }
  }
}

/**
 * Verify a VFS's single-file mutations in an empty, caller-owned scratch
 * directory, unlinking the files it wrote there, pass or fail.
 *
 * Write preconditions are checked exactly as `conditionSupport` declares
 * them, each op run through `runWithVersions` as a `write: conditional` mount
 * runs it: a declared condition lands when it holds and rejects as a stale
 * write, writing nothing, when it does not. An undeclared condition is
 * refused by the mount before the VFS sees it, so it is not probed. `rename`
 * and `copy` are checked where the VFS defines them: onto a fresh name and
 * over an existing file the destination holds the source's bytes, `rename`
 * removes the source and `copy` keeps it, and a missing source rejects ENOENT
 * and leaves the destination. `index` is the store every function is handed,
 * a RAM store at the VFS's `indexTtl` by default. `unenforced` names declared
 * conditions the backend under test cannot enforce (a fake), each skipped
 * with a warning; naming an undeclared one fails. Mirrors Python's
 * `check_mutation_contract`.
 */
export async function checkMutationContract(
  vfs: BaseVFS,
  fixture: MutationFixture,
  index?: IndexCacheStore,
  unenforced: readonly (readonly [WriteKind, ConditionMode])[] = [],
): Promise<void> {
  check(vfs.supports('write'), 'the mutation contract seeds through write')
  const checker = new Checker(vfs, fixture, index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl }))
  try {
    await checker.run(unenforced)
  } catch (error) {
    await checker.clean(true)
    throw error
  }
  await checker.clean(false)
}

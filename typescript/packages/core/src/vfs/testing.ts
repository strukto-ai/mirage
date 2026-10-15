import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { getExtension } from '../utils/filetype.ts'
import { isEnoent } from '../errors/fs.ts'
import type { FileStat } from '../types.ts'
import { DirListing, FileType, PathSpec } from '../types.ts'
import { mountPrefixOf } from '../utils/key_prefix.ts'
import type { BaseVFS } from './base.ts'
import type { Handed } from './types.ts'
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
    const actual = await read(path, slot, offset, size)
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
 * one, else `read`; a stream is compared with what `read` stores. A stream
 * and an existence check are probed only where the VFS defines them. A
 * renderer is always handed a byte window, `read` only where it takes one
 * natively: the caller reads whole and slices otherwise. `index` is the store every function is
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
  const data = await (render ?? vfs.read.bind(vfs))(fixture.file, file)
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
    render !== undefined && vfs.supports('read') ? await vfs.read(fixture.file, file) : data
  if (vfs.supports('readStream')) {
    const chunks: Uint8Array[] = []
    for await (const chunk of vfs.readStream(fixture.file, file)) {
      check(
        fixture.maxChunkSize === undefined || chunk.byteLength <= fixture.maxChunkSize,
        'readStream exceeded maxChunkSize',
      )
      chunks.push(chunk)
    }
    check(sameBytes(concat(chunks), stored), 'readStream differs from read')
  }
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
    (p: PathSpec) => readMissing(p, missing),
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

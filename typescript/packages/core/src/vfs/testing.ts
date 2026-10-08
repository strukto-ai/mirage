import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { getExtension } from '../commands/resolve.ts'
import { isEnoent } from '../errors/fs.ts'
import { type PathSpec, FileType } from '../types.ts'
import type { BaseVFS } from './base.ts'

/** A small known file, its parent directory, and an absent sibling. */
export interface ReadFixture {
  file: PathSpec
  directory: PathSpec
  missing: PathSpec
  content: Uint8Array
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

// Check that `read` answers a byte window of `data`, the whole file as
// `read` answers it. Mirrors Python's `_check_windows`.
async function checkWindows(
  read: BaseVFS['read'],
  path: PathSpec,
  store: IndexCacheStore,
  data: Uint8Array,
): Promise<void> {
  if (data.length === 0) return
  const offset = Math.min(1, data.length - 1)
  for (const size of [Math.min(3, data.length - offset), null]) {
    const actual = await read(path, store, offset, size)
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
  const render = renderer(vfs, fixture.file)
  const data = await (render ?? vfs.read.bind(vfs))(fixture.file, store)
  check(sameBytes(data, fixture.content), 'read differs from fixture content')
  const info = await vfs.stat(fixture.file, store)
  check(info.type === FileType.FILE, 'fixture must stat as a file')
  check(
    info.size === null || info.size === data.length,
    'stat size must be rendered byte length or null',
  )
  const parent = await vfs.stat(fixture.directory, store)
  check(parent.type === FileType.DIRECTORY, 'parent must stat as a directory')
  const children = await vfs.readdir(fixture.directory, store)
  check(children.includes(fixture.file.virtual), 'readdir must include the child virtual path')
  const stored =
    render !== undefined && vfs.supports('read') ? await vfs.read(fixture.file, store) : data
  if (vfs.supports('readStream')) {
    const chunks: number[] = []
    for await (const chunk of vfs.readStream(fixture.file, store)) chunks.push(...chunk)
    check(sameBytes(Uint8Array.from(chunks), stored), 'readStream differs from read')
  }
  if (render !== undefined) await checkWindows(render, fixture.file, store, data)
  if (vfs.readsRanges && vfs.supports('read')) {
    await checkWindows(vfs.read.bind(vfs), fixture.file, store, stored)
  }
  if (vfs.supports('exists')) {
    check(await vfs.exists(fixture.file), 'exists rejected the fixture file')
    check(!(await vfs.exists(fixture.missing)), 'exists accepted a missing file')
  }
  const readMissing = renderer(vfs, fixture.missing) ?? vfs.read.bind(vfs)
  for (const call of [
    (p: PathSpec) => vfs.stat(p, store),
    (p: PathSpec) => readMissing(p, store),
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

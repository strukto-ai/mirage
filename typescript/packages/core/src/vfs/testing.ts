import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
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

type ReadFn = (
  path: PathSpec,
  index?: IndexCacheStore,
  offset?: number,
  size?: number | null,
) => Promise<Uint8Array>

// What a read of `path` runs: the renderer of the filetype its name ends
// with, where the VFS renders one, else `read`. Mirrors Python's `_reader`.
function reader(vfs: BaseVFS, path: PathSpec): ReadFn {
  for (const [filetype, renderer] of Object.entries(vfs.renderers)) {
    if (!path.virtual.endsWith(filetype)) continue
    const render = (vfs as unknown as Record<string, ReadFn | undefined>)[renderer]
    check(render !== undefined, `renderer ${renderer} is not a method`)
    return render.bind(vfs)
  }
  return vfs.read.bind(vfs)
}

/**
 * Verify a VFS's reads against a caller-owned fixture, mutating nothing.
 *
 * A stream and an existence check are probed only where the VFS defines
 * them, and a byte window only where it reads ranges natively: the caller
 * reads whole and slices otherwise. `index` is the store every function is
 * handed, a RAM store at the VFS's `indexTtl` by default. Mirrors Python's
 * `check_read_contract`.
 */
export async function checkReadContract(
  vfs: BaseVFS,
  fixture: ReadFixture,
  index?: IndexCacheStore,
): Promise<void> {
  const store = index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl })
  const read = reader(vfs, fixture.file)
  const data = await read(fixture.file, store)
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
  if (vfs.supports('readStream')) {
    const chunks: number[] = []
    for await (const chunk of vfs.readStream(fixture.file, store)) chunks.push(...chunk)
    check(sameBytes(Uint8Array.from(chunks), data), 'readStream differs from read')
  }
  if (vfs.readsRanges && data.length > 0) {
    const offset = Math.min(1, data.length - 1)
    for (const size of [Math.min(3, data.length - offset), null]) {
      const actual = await read(fixture.file, store, offset, size)
      check(
        sameBytes(actual, data.slice(offset, size === null ? undefined : offset + size)),
        'read must use offset and byte count',
      )
    }
  }
  if (vfs.supports('exists')) {
    check(await vfs.exists(fixture.file), 'exists rejected the fixture file')
    check(!(await vfs.exists(fixture.missing)), 'exists accepted a missing file')
  }
  const readMissing = reader(vfs, fixture.missing)
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

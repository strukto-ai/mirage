import type { Accessor } from '../accessor/base.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { CommandIO } from '../commands/builtin/generic_bind/adapter.ts'
import { type ByteSource, materialize } from '../io/types.ts'
import type { OpKwargs, RegisteredOp } from '../ops/registry.ts'
import { type FileStat, FileType, type PathSpec } from '../types.ts'
import { isEnoent } from '../errors/fs.ts'
import { VFSAdapter } from './adapter.ts'
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

/** Verify reads against a caller-owned fixture without mutations or test dependencies.
 * Native ranges probe nonempty windows within the fixture. Empty and out-of-range
 * reads are normalized by the filesystem operation instead. */
export async function checkReadContract<A extends Accessor>(
  adapter: VFSAdapter<A> | CommandIO<A>,
  accessor: A,
  fixture: ReadFixture,
  index?: IndexCacheStore,
): Promise<void> {
  const io = adapter instanceof VFSAdapter ? adapter.toCommandIO() : adapter
  const data = await io.readBytes(accessor, fixture.file, index)
  check(sameBytes(data, fixture.content), 'readBytes differs from fixture content')
  const info = await io.stat(accessor, fixture.file, index)
  check(info.type === FileType.FILE, 'stat must classify the fixture as a file')
  check(
    info.size === null || info.size === data.length,
    'stat size must be rendered byte length or null',
  )
  const parent = await io.stat(accessor, fixture.directory, index)
  check(parent.type === FileType.DIRECTORY, 'stat must classify the parent as a directory')
  const children = await io.readdir(accessor, fixture.directory, index)
  check(children.includes(fixture.file.virtual), 'readdir must include the child virtual path')
  const chunks: number[] = []
  for await (const chunk of io.readStream(accessor, fixture.file, index)) chunks.push(...chunk)
  check(sameBytes(Uint8Array.from(chunks), data), 'readStream differs from readBytes')
  if (io.readRange !== undefined && data.length > 0) {
    const offset = Math.min(1, data.length - 1)
    for (const size of [Math.min(3, data.length - offset), undefined]) {
      const actual = await io.readRange(accessor, fixture.file, index, offset, size ?? null)
      check(
        sameBytes(actual, data.slice(offset, size === undefined ? undefined : offset + size)),
        'readRange must use offset and byte count',
      )
    }
  }
  if (io.exists !== undefined) {
    check(await io.exists(accessor, fixture.file), 'exists rejected the fixture file')
    check(!(await io.exists(accessor, fixture.missing)), 'exists accepted a missing file')
  }
  for (const operation of [io.stat, io.readBytes]) {
    try {
      await operation(accessor, fixture.missing, index)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    throw new Error('missing paths must raise ENOENT')
  }
}

/**
 * A driver's op table, callable the way a mount calls it: the accessor
 * bound, one index store per instance, the mount's argument conventions,
 * so a driver can be exercised, or scripted, without a Workspace. A verb
 * the table does not carry is a `no op registered` error, the same answer
 * a mount gives. Mirrors Python's `DriverOps`.
 */
export class DriverOps {
  readonly index: IndexCacheStore

  constructor(
    readonly vfs: BaseVFS,
    index?: IndexCacheStore,
  ) {
    this.index = index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl })
  }

  /** The registration serving `name` for every filetype. */
  op(name: string): RegisteredOp {
    const op = this.vfs.ops().find((o) => o.name === name && o.filetype === null)
    if (op === undefined) throw new Error(`no op registered: ${name} for VFS ${this.vfs.name}`)
    return op
  }

  /** Whether the table serves `name` for every filetype. */
  has(name: string): boolean {
    return this.vfs.ops().some((o) => o.name === name && o.filetype === null)
  }

  /** Call op `name` on `path`; `index` defaults to this instance's store. */
  call(
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    return Promise.resolve(
      this.op(name).fn(this.vfs.accessor, path, args, { index: this.index, ...kwargs }),
    )
  }

  read(path: PathSpec, kwargs: OpKwargs = {}): Promise<Uint8Array> {
    return this.call('read', path, [], kwargs) as Promise<Uint8Array>
  }

  readdir(path: PathSpec): Promise<string[]> {
    return this.call('readdir', path) as Promise<string[]>
  }

  stat(path: PathSpec): Promise<FileStat> {
    return this.call('stat', path) as Promise<FileStat>
  }

  glob(path: PathSpec): Promise<PathSpec[]> {
    return this.call('glob', path) as Promise<PathSpec[]>
  }

  async write(path: PathSpec, data: Uint8Array): Promise<void> {
    await this.call('write', path, [data])
  }

  async append(path: PathSpec, data: Uint8Array): Promise<void> {
    await this.call('append', path, [data])
  }

  async create(path: PathSpec): Promise<void> {
    await this.call('create', path)
  }

  async mkdir(path: PathSpec, parents = false): Promise<void> {
    await this.call('mkdir', path, [], parents ? { parents: true } : {})
  }

  async unlink(path: PathSpec): Promise<void> {
    await this.call('unlink', path)
  }

  async rmdir(path: PathSpec): Promise<void> {
    await this.call('rmdir', path)
  }

  async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.call('rename', src, [dst], { dst })
  }

  async truncate(path: PathSpec, length: number): Promise<void> {
    await this.call('truncate', path, [length])
  }
}

/**
 * Verify a driver's read ops against a caller-owned fixture. The
 * driver-level twin of {@link checkReadContract}: the checks run through
 * the table `vfs.ops()` serves, the one channel a mount dispatches to, so
 * they hold for a builtin-shaped subclass as much as for a driver built
 * from an adapter. The `read` op's window is always probed, since the op
 * slices a whole read when the table has no native range. Nothing is
 * mutated. Mirrors Python's `check_driver_contract`.
 */
export async function checkDriverContract(
  vfs: BaseVFS,
  fixture: ReadFixture,
  index?: IndexCacheStore,
): Promise<void> {
  const table = new DriverOps(vfs, index)
  const read = async (kwargs: OpKwargs = {}): Promise<Uint8Array> =>
    materialize((await table.call('read', fixture.file, [], kwargs)) as ByteSource)
  const data = await read()
  check(sameBytes(data, fixture.content), 'read differs from fixture content')
  const info = await table.stat(fixture.file)
  check(info.type === FileType.FILE, 'stat must classify the fixture as a file')
  check(
    info.size === null || info.size === data.length,
    'stat size must be rendered byte length or null',
  )
  const parent = await table.stat(fixture.directory)
  check(parent.type === FileType.DIRECTORY, 'stat must classify the parent as a directory')
  const children = await table.readdir(fixture.directory)
  check(children.includes(fixture.file.virtual), 'readdir must include the child virtual path')
  if (data.length > 0) {
    const offset = Math.min(1, data.length - 1)
    for (const size of [Math.min(3, data.length - offset), null]) {
      const actual = await read({ offset, size })
      check(
        sameBytes(actual, data.slice(offset, size === null ? undefined : offset + size)),
        'read must use offset and byte count',
      )
    }
  }
  for (const operation of [
    () => table.stat(fixture.missing),
    () => table.call('read', fixture.missing),
  ]) {
    try {
      await operation()
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    throw new Error('missing paths must raise ENOENT')
  }
}

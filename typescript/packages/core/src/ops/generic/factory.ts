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

import type { Accessor } from '../../accessor/base.ts'
import { cat as featherCat } from '../../core/filetype/feather.ts'
import { cat as hdf5Cat } from '../../core/filetype/hdf5.ts'
import { cat as parquetCat } from '../../core/filetype/parquet.ts'
import type { OpKwargs, RegisteredOp } from '../registry.ts'
import { extractWriteData } from '../write_args.ts'
import type { PathSpec } from '../../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpCoreFn = (...args: any[]) => unknown

/**
 * Structural subset of a backend's `CommandIO` the ops factory consumes.
 * The table in `commands/builtin/<b>/ops.ts` already carries every core
 * function the VFS/FUSE op wrappers forward to, so the same table feeds
 * both `makeGenericCommands` and `makeGenericOps`. Command-only fields
 * (`readStream`, `isMounted`, `find`, ...) are ignored.
 */
export interface OpsTable<A extends Accessor = Accessor> {
  readdir: (accessor: A, path: PathSpec, index?: OpKwargs['index']) => unknown
  readBytes: (accessor: A, path: PathSpec, index?: OpKwargs['index']) => Promise<Uint8Array>
  stat: (accessor: A, path: PathSpec, index?: OpKwargs['index']) => unknown
  write?: OpCoreFn
  mkdir?: OpCoreFn
  unlink?: OpCoreFn
  rmdir?: OpCoreFn
  rename?: OpCoreFn
  create?: OpCoreFn
  truncate?: OpCoreFn
  append?: OpCoreFn
  setAttrs?: OpCoreFn
}

const FILETYPE_CATS: Record<string, (raw: Uint8Array) => unknown> = {
  '.parquet': parquetCat,
  '.feather': featherCat,
  '.hdf5': hdf5Cat,
  '.h5': hdf5Cat,
}

export interface MakeGenericOpsOptions {
  /** Extensions to emit rendered `read` ops for (keys of FILETYPE_CATS). */
  filetypeRead?: readonly string[]
  /** Synthesize truncate from readBytes + write (no native partial write). */
  emulateTruncate?: boolean
  /** Forward `parents=true` to the core mkdir (disk). */
  mkdirParents?: boolean
  /** Op names to skip because the backend registers an irregular wrapper. */
  overrides?: ReadonlySet<string>
  /**
   * Forward `kwargs.index` into read/readdir/stat (default true). Mutable
   * local backends (ram/disk/redis/ssh) historically call their cores
   * index-less: their readdir caches listings into the index store while
   * mutations never invalidate them, so forwarding would serve stale
   * listings after mkdir/rmdir/write.
   */
  forwardIndex?: boolean
}

const expectPathSpec = (value: unknown, op: string): PathSpec => {
  if (value === null || typeof value !== 'object' || !('virtual' in value)) {
    throw new TypeError(`${op} op requires a dst PathSpec as the first arg`)
  }
  return value as PathSpec
}

const expectLength = (value: unknown): number => {
  if (typeof value !== 'number') {
    throw new TypeError('truncate op requires a number length as the first arg')
  }
  return value
}

/**
 * Generate a backend's VFS/FUSE op set from its `CommandIO` table.
 *
 * The per-backend `ops/<b>/` wrapper modules were hand-written forwards
 * of a handful of shapes; this factory emits the same wrappers from the
 * table that already feeds `makeGenericCommands`, so a backend declares
 * its core surface once. Ops whose table field is undefined are
 * omitted, mirroring how the command factory skips write commands on
 * read-only backends.
 */
export function makeGenericOps<A extends Accessor>(
  resource: string | readonly string[],
  table: OpsTable<A>,
  options: MakeGenericOpsOptions = {},
): RegisteredOp[] {
  const resources = typeof resource === 'string' ? [resource] : resource
  const skip = options.overrides ?? new Set<string>()
  const ops: RegisteredOp[] = []

  const emit = (
    name: string,
    fn: RegisteredOp['fn'],
    write: boolean,
    filetype: string | null = null,
  ): void => {
    if (skip.has(name)) return
    for (const res of resources) {
      ops.push({ name, resource: res, filetype, fn, write })
    }
  }

  const asA = (accessor: Accessor): A => accessor as A
  const pickIndex = (kwargs: OpKwargs): OpKwargs['index'] =>
    options.forwardIndex === false ? undefined : kwargs.index

  emit(
    'read',
    (accessor, path, _args, kwargs) => table.readBytes(asA(accessor), path, pickIndex(kwargs)),
    false,
  )
  emit(
    'readdir',
    (accessor, path, _args, kwargs) => table.readdir(asA(accessor), path, pickIndex(kwargs)),
    false,
  )
  emit(
    'stat',
    (accessor, path, _args, kwargs) => table.stat(asA(accessor), path, pickIndex(kwargs)),
    false,
  )

  for (const ext of options.filetypeRead ?? []) {
    const cat = FILETYPE_CATS[ext]
    if (!cat) throw new Error(`no filetype cat registered for ${ext}`)
    emit(
      'read',
      async (accessor, path, _args, kwargs) => {
        const raw = await table.readBytes(asA(accessor), path, pickIndex(kwargs))
        return cat(raw)
      },
      false,
      ext,
    )
  }

  const { write, mkdir, unlink, rmdir, rename, create, truncate, append, setAttrs } = table
  if (write) {
    emit(
      'write',
      (accessor, path, args) => write(asA(accessor), path, extractWriteData(args)),
      true,
    )
  }
  if (append) {
    emit(
      'append',
      (accessor, path, args) => append(asA(accessor), path, extractWriteData(args)),
      true,
    )
  }
  if (create) {
    emit('create', (accessor, path) => create(asA(accessor), path), true)
  }
  if (mkdir) {
    emit(
      'mkdir',
      (accessor, path) =>
        options.mkdirParents ? mkdir(asA(accessor), path, true) : mkdir(asA(accessor), path),
      true,
    )
  }
  if (unlink) {
    emit('unlink', (accessor, path) => unlink(asA(accessor), path), true)
  }
  if (rmdir) {
    emit('rmdir', (accessor, path) => rmdir(asA(accessor), path), true)
  }
  if (rename) {
    emit(
      'rename',
      (accessor, path, args) => rename(asA(accessor), path, expectPathSpec(args[0], 'rename')),
      true,
    )
  }

  if (truncate) {
    emit(
      'truncate',
      (accessor, path, args) => truncate(asA(accessor), path, expectLength(args[0])),
      true,
    )
  } else if (options.emulateTruncate) {
    if (!write) {
      throw new Error('emulateTruncate requires a write op on the table')
    }
    emit(
      'truncate',
      async (accessor, path, args) => {
        const length = expectLength(args[0])
        let data: Uint8Array
        try {
          data = await table.readBytes(asA(accessor), path)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          data = new Uint8Array(0)
        }
        const out = new Uint8Array(length)
        out.set(data.subarray(0, length))
        return write(asA(accessor), path, out)
      },
      true,
    )
  }

  if (setAttrs) {
    emit('setattr', (accessor, path, _args, kwargs) => setAttrs(asA(accessor), path, kwargs), true)
  }

  return ops
}

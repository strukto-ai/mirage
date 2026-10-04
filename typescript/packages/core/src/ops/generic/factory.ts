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

import { enotsup } from '../../utils/errors.ts'
import type { Accessor } from '../../accessor/base.ts'
import type { OpKwargs, RegisteredOp } from '../registry.ts'
import type { MakeGenericOpsOptions, OpsTable } from './types.ts'
import { isUnsatisfiableRange, sliceWindow, spliceWindow } from '../../utils/ranges.ts'
import { DEFAULT_MAX_GLOB_MATCHES, resolveGlobWith } from '../../utils/glob_walk.ts'
import { einval, eisdir, isMissingPath } from '../../utils/errors.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'

const expectPathSpec = (value: unknown, op: string): PathSpec => {
  if (value === null || typeof value !== 'object' || !('virtual' in value)) {
    throw new TypeError(`${op} op requires a dst PathSpec as the first arg`)
  }
  return value as PathSpec
}

const extractWriteData = (args: readonly unknown[]): Uint8Array => {
  const first = args[0]
  if (first instanceof Uint8Array) return first
  throw new TypeError('write op requires a Uint8Array as the first arg')
}

const expectLength = (value: unknown): number => {
  if (typeof value !== 'number') {
    throw new TypeError('truncate op requires a number length as the first arg')
  }
  return value
}

const expectOffset = (value: unknown, path: PathSpec): number => {
  if (typeof value !== 'number') {
    throw new TypeError('pwrite op requires a number offset as the second arg')
  }
  if (!Number.isInteger(value) || value < 0) throw einval(path)
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
 * read-only backends. A writable table without a native append or pwrite
 * builds them from read and write; like emulated truncate, this is not
 * atomic against concurrent writers.
 */
export function makeGenericOps<A extends Accessor>(
  vfs: string | readonly string[],
  table: OpsTable<A>,
  options: MakeGenericOpsOptions = {},
): RegisteredOp[] {
  const vfsNames = typeof vfs === 'string' ? [vfs] : vfs
  const skip = options.overrides ?? new Set<string>()
  const ops: RegisteredOp[] = []

  const emit = (
    name: string,
    fn: RegisteredOp['fn'],
    write: boolean,
    filetype: string | null = null,
    ranges = false,
  ): void => {
    if (skip.has(name)) return
    for (const res of vfsNames) {
      ops.push({ name, vfs: res, filetype, fn, write, ranges })
    }
  }

  const asA = (accessor: Accessor): A => accessor as A

  // A backend that can fetch a range natively does so, which is the whole
  // point on an object store: one ranged GET instead of the whole file. Every
  // other backend falls back to reading and slicing, which is the same answer
  // at the same cost as before, and is the only meaningful behavior for a
  // backend that renders its content rather than storing it, since there is no
  // remote range to ask for. A zero-length read is answered here rather than
  // sent anywhere: no store can express an empty range, and the answer is known.
  //
  // A window starting at or past EOF is the one case where the two paths do not
  // agree on their own: slicing yields empty, the POSIX answer, while an HTTP
  // store refuses with 416. Normalizing here rather than in each reader keeps
  // the op's contract one thing, and keeps a backend from becoming the odd one
  // out the day it grows a native range.
  emit(
    'read',
    async (accessor, path, _args, kwargs) => {
      const offset = typeof kwargs.offset === 'number' ? kwargs.offset : 0
      const size = typeof kwargs.size === 'number' ? kwargs.size : null
      if (size === 0) return new Uint8Array(0)
      const whole = offset === 0 && size === null
      const native = table.readRange
      if (native !== undefined && !whole) {
        try {
          return await native(asA(accessor), path, kwargs.index, offset, size)
        } catch (err) {
          if (!isUnsatisfiableRange(err)) throw err
          return new Uint8Array(0)
        }
      }
      const data = await table.readBytes(asA(accessor), path, kwargs.index)
      return whole ? data : sliceWindow(data, offset, size)
    },
    false,
    null,
    table.readRange !== undefined,
  )
  emit(
    'readdir',
    (accessor, path, _args, kwargs) => table.readdir(asA(accessor), path, kwargs.index),
    false,
  )
  emit(
    'stat',
    (accessor, path, _args, kwargs) => table.stat(asA(accessor), path, kwargs.index),
    false,
  )

  // Glob expansion is a walk over readdir, so it is derived here rather
  // than written per driver: one walker, capped by the table's own limit,
  // with the table's stat so a trailing slash keeps directories only. The
  // mount hands it one pattern spec at a time and passes the rest
  // through, which is what every driver's resolver did with the list.
  const readdirOf = table.readdir as (
    accessor: A,
    path: PathSpec,
    index?: OpKwargs['index'],
  ) => Promise<string[]>
  const statOf = table.stat as (
    accessor: A,
    path: PathSpec,
    index?: OpKwargs['index'],
  ) => Promise<FileStat>
  emit(
    'glob',
    (accessor, path, _args, kwargs) =>
      resolveGlobWith(
        readdirOf,
        asA(accessor),
        [path],
        kwargs.index,
        table.maxGlobMatches ?? DEFAULT_MAX_GLOB_MATCHES,
        undefined,
        statOf,
      ),
    false,
  )

  const { write, mkdir, unlink, rmdir, rename, create, truncate, append, pwrite, setAttrs } = table
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
  } else if (write) {
    emit(
      'append',
      async (accessor, path, args, kwargs) => {
        const data = extractWriteData(args)
        // A zero-byte append is an open for appending with nothing written
        // after it (`exec >> f`, `: >> f`): it creates a missing file and
        // leaves an existing one alone. Reading and rewriting the whole
        // object to add nothing would move it twice and could put back bytes
        // a concurrent writer had just replaced.
        if (data.length === 0) {
          let found: unknown
          try {
            found = await table.stat(asA(accessor), path, kwargs.index)
          } catch (error) {
            if (!isMissingPath(error)) throw error
            return write(asA(accessor), path, data)
          }
          if (found instanceof FileStat && found.type === FileType.DIRECTORY) throw eisdir(path)
          return
        }
        let existing: Uint8Array
        // The read takes the caller's index, like every other read here: an
        // id-addressed backend (Box, Drive) turns a path into an id through
        // it, and without one every read is a miss, so each append would
        // overwrite what the last one wrote.
        try {
          existing = await table.readBytes(asA(accessor), path, kwargs.index)
        } catch (error) {
          if (!isMissingPath(error)) throw error
          return write(asA(accessor), path, data)
        }
        const joined = new Uint8Array(existing.length + data.length)
        joined.set(existing)
        joined.set(data, existing.length)
        return write(asA(accessor), path, joined)
      },
      true,
    )
  }
  if (pwrite) {
    emit(
      'pwrite',
      (accessor, path, args) =>
        pwrite(asA(accessor), path, extractWriteData(args), expectOffset(args[1], path)),
      true,
    )
  } else if (write) {
    emit(
      'pwrite',
      async (accessor, path, args, kwargs) => {
        const data = extractWriteData(args)
        const offset = expectOffset(args[1], path)
        // A zero-length pwrite(2) on an existing file changes nothing and
        // must not read the file back: a concurrent writer's update between
        // this stat and a would-be write would be clobbered by the stale
        // contents. A zero-length pwrite on a missing file creates an empty
        // file (pwrite(2) with O_CREAT semantics).
        if (data.length === 0) {
          try {
            const found = await table.stat(asA(accessor), path, kwargs.index)
            if (found instanceof FileStat && found.type === FileType.DIRECTORY) throw eisdir(path)
            return
          } catch (error) {
            if (!isMissingPath(error)) throw error
            return write(asA(accessor), path, data)
          }
        }
        // The read is this op's own, below the door that judged it a write:
        // a session that may write a file and not read it still writes at
        // an offset, as pwrite(2) on a write-only descriptor does. It takes
        // the caller's index for the reason append does.
        let existing: Uint8Array
        try {
          existing = await table.readBytes(asA(accessor), path, kwargs.index)
        } catch (error) {
          if (!isMissingPath(error)) throw error
          // A key store answers a read of a directory's name as a missing
          // key; writing there would put an object beside the directory.
          let found: unknown = null
          try {
            found = await table.stat(asA(accessor), path, kwargs.index)
          } catch (statError) {
            if (!isMissingPath(statError)) throw statError
          }
          if (found instanceof FileStat && found.type === FileType.DIRECTORY) throw eisdir(path)
          existing = new Uint8Array()
        }
        return write(asA(accessor), path, spliceWindow(existing, offset, data))
      },
      true,
    )
  }
  if (create) {
    emit('create', (accessor, path) => create(asA(accessor), path), true)
  }
  if (mkdir) {
    // A per-call `parents: true` kwarg (pathlib's mkdir(parents=True)
    // through a runtime bridge) forwards like python's registry, which
    // hands dispatch kwargs to the op; `mkdirParents` still forces it
    // for backends whose core requires the flag (databricks_volume).
    emit(
      'mkdir',
      (accessor, path, _args, kwargs) =>
        options.mkdirParents || kwargs.parents === true
          ? mkdir(asA(accessor), path, true)
          : mkdir(asA(accessor), path),
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
      (accessor, path, args, opts) =>
        truncate(asA(accessor), path, expectLength(args[0]), opts.no_create === true),
      true,
    )
  } else if (options.emulateTruncate) {
    if (!write) {
      throw new Error('emulateTruncate requires a write op on the table')
    }
    emit(
      'truncate',
      async (accessor, path, args, opts) => {
        if (opts.no_create === true) throw enotsup('emulated', 'truncate --no-create', path)
        const length = expectLength(args[0])
        let data: Uint8Array
        try {
          data = await table.readBytes(asA(accessor), path)
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') throw err
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

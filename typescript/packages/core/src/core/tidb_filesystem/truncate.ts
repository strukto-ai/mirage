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

import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { eisdir, enotsup, isEnoent, staleWrite } from '../../errors/fs.ts'
import { callerSignal } from '../../context/session_context.ts'
import { CHUNK_SIZE } from '../../io/cooperative.ts'
import { ByteSpool } from '../../io/spool.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { record, startOp } from '../../observe/context.ts'
import { FileType, VFSName, type FileStat, type PathSpec } from '../../types.ts'
import { expectOffset } from '../generic/rewrite.ts'
import { appendTo, shrinkTo } from './client.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'
import { read } from './read.ts'
import { stat } from './stat.ts'
import { write } from './write.ts'

async function pad(spool: ByteSpool, count: number): Promise<void> {
  const budget = new YieldBudget(callerSignal())
  for (let at = 0; at < count; at += CHUNK_SIZE) {
    await spool.append(new Uint8Array(Math.min(CHUNK_SIZE, count - at)))
    await budget.run()
  }
}

async function fileAt(accessor: TiDBFilesystemAccessor, path: PathSpec): Promise<FileStat | null> {
  let found: FileStat
  try {
    found = await stat(accessor, path)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
  if (found.type === FileType.DIRECTORY) throw eisdir(path)
  return found
}

/**
 * Resize a file, cutting its end or padding it with zeros. A file drive9
 * keeps in object storage is cut by a patch upload, which moves only the part
 * the cut falls in, and grown by a native append of the zeros, refused when
 * the file changed size since its stat. A file drive9 keeps inline sits in one
 * TiDB row that any change rewrites whole, so it is read and written back, as
 * is a missing file, which is made. A grow another writer raced is refused
 * with STALE_WRITE and writes nothing. drive9 has no create-only write, so
 * `noCreate` is refused before anything is sent.
 */
export async function truncate(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  if (noCreate) throw enotsup(VFSName.TIDB_FILESYSTEM, 'truncate --no-create', path)
  length = expectOffset(length, path)
  const timer = startOp()
  const found = await fileAt(accessor, path)
  const size = found?.size ?? 0
  if (found !== null && length === size) return
  const remote = backendPath(accessor.config, path)
  if (found !== null && length > 0) {
    let done: boolean
    if (length < size) {
      done = await shrinkTo(accessor, remote, length)
    } else {
      const added = new ByteSpool()
      try {
        await pad(added, length - size)
        done = await appendTo(accessor, remote, added, size)
      } catch (exc) {
        if (hasStatus(exc, 412)) throw staleWrite(path)
        throw exc
      } finally {
        await added.close()
      }
    }
    if (done) {
      record('truncate', path.virtual, VFSName.TIDB_FILESYSTEM, 0, timer)
      return
    }
  }
  const kept = Math.min(size, length)
  const content = new ByteSpool()
  try {
    if (kept > 0) await content.append(await read(accessor, path, 0, kept))
    await pad(content, length - kept)
    await write(accessor, path, content)
  } finally {
    await content.close()
  }
  record('truncate', path.virtual, VFSName.TIDB_FILESYSTEM, 0, timer)
}

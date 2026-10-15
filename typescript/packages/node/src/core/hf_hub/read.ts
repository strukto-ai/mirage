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

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { FileType, type FileStat, type PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/errors/fs'
import type { ByteWindow } from '@struktoai/mirage-core/utils/ranges'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { etagValue, hubBytesTagged, resolveUrl } from './client.ts'
import { REFUSED_STATUSES } from './constants.ts'
import { refusalsDenied } from './lookup.ts'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'

export interface HfHubReadOptions {
  offset?: number
  size?: number
}

/**
 * The file's row, or the error that says why there is none.
 *
 * Shared by every content read so a file, a directory and an absence are told
 * apart in exactly one place. It also means a read never reaches the network
 * for a path the listing already knows is absent. Mirrors Python's
 * `resolve_entry`.
 */
export function resolveEntry(pathSpec: PathSpec, entry: FileStat | null | undefined): FileStat {
  if (stripSlash(pathSpec.mountPath) === '') throw eisdir(pathSpec.virtual)
  if (entry === undefined || entry === null) throw enoent(pathSpec.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(pathSpec.virtual)
  return entry
}

/**
 * The row's oid, if the response's ETag shows the bytes are that row's.
 *
 * The listing can be older than the download: the listing lives until the
 * mount re-lists it, while resolve always serves the revision's current bytes.
 * Stamping the listing's oid on newer bytes would let a later revert to that
 * oid pass them off as fresh, so the oid is stamped only when the ETag names
 * one of the row's own ids (the oid for a plain file, the xet hash for a Xet
 * one), and otherwise nothing is.
 */
export function rowToken(entry: FileStat, etag: string): string | null {
  const ids = new Set<string>()
  for (const id of [entry.fingerprint, entry.extra.lfs_oid, entry.extra.xet_hash]) {
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  if (!ids.has(etagValue(etag))) return null
  return entry.fingerprint
}

export async function read(
  accessor: HfHubAccessor,
  path: PathSpec,
  options: HfHubReadOptions = {},
  entry?: FileStat | null,
): Promise<Uint8Array> {
  const row = resolveEntry(path, entry)
  const url = resolveUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    accessor.revision,
    accessor.repoPath(path.mountPath),
  )
  // `size: null` is the window's own spelling for "the rest of the file",
  // which is not the same as asking for no window at all.
  const hasWindow = (options.offset ?? 0) > 0 || options.size !== undefined
  const window: ByteWindow | undefined = hasWindow
    ? { offset: options.offset ?? 0, size: options.size ?? null }
    : undefined
  const timer = startOp()
  const [data, etag] = await refusalsDenied(
    path,
    () => hubBytesTagged(accessor.token, url, window, accessor.timeoutMs),
    REFUSED_STATUSES,
  )
  record('read', path.virtual, accessor.vfsName, data.length, timer, {
    fingerprint: rowToken(row, etag),
  })
  return data
}

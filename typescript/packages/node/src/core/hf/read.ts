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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/utils/errors'
import type { ByteWindow } from '@struktoai/mirage-core/utils/ranges'
import type { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError, hubBytesTagged } from '../hf_hub/client.ts'
import { REFUSED_STATUSES } from '../hf_hub/constants.ts'
import { refusalsDenied } from '../hf_hub/lookup.ts'
import { readToken, resolveUrl } from './hub.ts'

const MISSING_ENTRY = 'EntryNotFound'

const UNSATISFIABLE = 416

export interface HfReadOptions {
  offset?: number
  size?: number
}

/**
 * Whether a download refusal says the file does not exist.
 *
 * Only a 404 carrying `EntryNotFound` does. A 404 without it (a CDN hop, a
 * bucket the token cannot see) is a failed read of a file that may well exist,
 * and reading it as absence would let reconcile drop the path's overlay.
 */
export function isMissing(err: unknown): boolean {
  return err instanceof HfHubError && err.status === 404 && err.errorCode === MISSING_ENTRY
}

/**
 * Read a bucket file, or a byte window of it, from the Hub.
 *
 * Not through opendal: its read returns bare bytes, and the ETag the download
 * carries is the file's xet hash, the token stat reports, so it is stamped on
 * the read record as it comes.
 */
export async function read(
  accessor: HfBucketsAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: HfReadOptions = {},
): Promise<Uint8Array> {
  const rel = path.mountPath
  if (rel.replace(/^\/+|\/+$/g, '') === '') throw eisdir(path)
  // No request: a zero-length Range header is not one the Hub, or the client
  // building it, accepts.
  if (options.size === 0) return new Uint8Array()
  // `size: null` is the window's own spelling for "the rest of the file",
  // which is not the same as asking for no window at all.
  const hasWindow = (options.offset ?? 0) > 0 || options.size !== undefined
  const window: ByteWindow | undefined = hasWindow
    ? { offset: options.offset ?? 0, size: options.size ?? null }
    : undefined
  const timer = startOp()
  let data: Uint8Array
  let etag: string
  try {
    ;[data, etag] = await refusalsDenied(
      path,
      () => hubBytesTagged(accessor.token, resolveUrl(accessor, rel), window),
      REFUSED_STATUSES,
    )
  } catch (err) {
    if (isMissing(err)) throw enoent(path)
    if (!(err instanceof HfHubError) || err.status !== UNSATISFIABLE || window === undefined) {
      throw err
    }
    // A window starting at or past EOF: the Hub answers 416 where a POSIX read
    // returns nothing. Folded here rather than left to the ops factory,
    // because a caller reading the range door directly has no fold of its own.
    data = new Uint8Array()
    etag = ''
  }
  record('read', path.virtual, accessor.vfsName, data.byteLength, timer, {
    fingerprint: readToken(etag),
  })
  return data
}

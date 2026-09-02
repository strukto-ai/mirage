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

import { classifyErrno, EINVAL } from '../mount/errors.ts'

/** Base for conditions the NFS adapter reports to the server layer. */
export class NFSError extends Error {}

/**
 * A file id the adapter no longer knows. Answered to the client as
 * NFS3ERR_STALE. Raised rather than returned so a caller cannot
 * mistake it for a valid path: an id is stale for the rest of the
 * mount's life, never revalidated.
 */
export class StaleHandleError extends NFSError {}

/**
 * A rename whose destination lies inside its source, refused before
 * the backend or the id table is touched. Carries EINVAL, which the
 * wire layer answers as NFS3ERR_INVAL.
 */
export class RenameIntoSelfError extends NFSError {
  readonly errno = EINVAL
}

/**
 * ESTALE as the addon's errno table spells it.
 *
 * `bridge.rs` maps 70 onto NFS3ERR_STALE, and that table is the contract, not
 * the host's errno.h: linux calls ESTALE 116, which the same table would
 * answer as NFS3ERR_IO. Staleness is also not a condition core's `classify`
 * names, since no mirage backend can report it — only the id table can.
 */
export const ESTALE_WIRE = 70

/**
 * The errno an adapter failure crosses the boundary as.
 *
 * The twin of the PyO3 crate's `to_status`, on this side of the boundary
 * because no exception may reach the addon: a stale handle answers ESTALE
 * directly, an NFS-native refusal carries its own number, and everything else
 * goes through the shared `classifyErrno` table the FUSE adapter uses, so one
 * backend failure is named once in one place.
 */
export function nfsErrno(err: unknown): number {
  if (err instanceof StaleHandleError) return ESTALE_WIRE
  if (err instanceof NFSError) {
    const own = (err as { errno?: unknown }).errno
    if (typeof own === 'number') return own
  }
  return classifyErrno(err)
}

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

import { DEFAULT_UMASK } from '../../context/session_context.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { PathSpec } from '../../types.ts'
import { isFsError } from '../../utils/errors.ts'
import type { SessionState } from '../session/session.ts'

/**
 * Write a file, giving it the umask's mode if the write created it.
 *
 * Every shell path that opens a file for writing goes through here, so
 * `echo x > f` and `exec > f` agree about the mode a fresh file gets:
 * 0666 masked by the session's umask, which is what `open(2)` with
 * `O_CREAT` does. Living in one place is the point; the two callers had
 * drifted while it was private to one of them.
 *
 * The existence probe runs only under a non-default umask, because that
 * is the one case the answer changes anything: a fresh file already
 * renders as 644, which is 0666 under bash's default mask. A mode that
 * cannot be written is swallowed and not fatal, since the bytes are
 * already there and the write is what the caller asked for.
 */
export async function createFile(
  dispatch: DispatchFn,
  session: SessionState,
  scope: PathSpec,
  data: Uint8Array,
): Promise<void> {
  let created = false
  if (session.umask !== DEFAULT_UMASK) {
    try {
      await dispatch('stat', scope)
    } catch (statErr) {
      if (!isFsError(statErr)) throw statErr
      created = true
    }
  }
  await dispatch('write', scope, [data])
  if (!created) return
  try {
    await dispatch('setattr', scope, [], { mode: 0o666 & ~session.umask })
  } catch (modeErr) {
    if (!isFsError(modeErr)) throw modeErr
  }
}

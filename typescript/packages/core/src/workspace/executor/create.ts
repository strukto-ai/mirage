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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import type { FileDescription } from '../../shell/descriptors.ts'
import { DEFAULT_UMASK, getCurrentEvaluation } from '../../context/session_context.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { PathSpec } from '../../types.ts'
import { isFsError } from '../../errors/fs.ts'
import { spliceWindow } from '../../utils/ranges.ts'
import type { SessionState } from '../session/session.ts'
import { hasAborted, makeAbortError } from '../abort.ts'

/**
 * Write or append, giving a newly created file the umask's mode.
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
  append = false,
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
  await dispatch(append ? 'append' : 'write', scope, [data])
  if (!created) return
  try {
    await dispatch('setattr', scope, [], { mode: 0o666 & ~session.umask })
  } catch (modeErr) {
    if (!isFsError(modeErr)) throw modeErr
  }
}

/**
 * Write through a shared open description and advance its offset.
 *
 * A write-only description lands at its offset with one `pwrite`, so it
 * needs no read of the file, as a write to a write-only descriptor needs none
 * (`exec 3>f; echo a >&3`). A read-write one (`<>`) still reads it: that
 * description was opened to read, and its own reader resumes over what the
 * write left. Writes through one description take turns, the first one
 * (which opens the file) included, as the kernel orders writes to an open
 * file: a background job writing alongside the shell neither reopens the
 * file nor lands on an offset another write has not advanced yet. A writer
 * killed while it waits for its turn writes nothing: a promise cannot be
 * cancelled, so the turn checks the writer's execution frame, as
 * Python's cancelled task leaves the queue.
 */
export async function writeDescription(
  dispatch: DispatchFn,
  session: SessionState,
  file: FileDescription,
  data: Uint8Array,
): Promise<void> {
  if (file.emit !== null) {
    if (data.byteLength > 0) await file.emit(data)
    return
  }
  const turn = file.writing
  let done = (): void => undefined
  file.writing = new Promise((resolve) => (done = resolve))
  try {
    await turn
    const writer = getCurrentEvaluation()?.frame.abortSignal ?? undefined
    if (hasAborted(writer)) throw makeAbortError(writer)
    await writeThrough(dispatch, session, file, data)
  } finally {
    done()
  }
}

async function writeThrough(
  dispatch: DispatchFn,
  session: SessionState,
  file: FileDescription,
  data: Uint8Array,
): Promise<void> {
  if (!file.opened) {
    await createFile(
      dispatch,
      session,
      file.scope,
      file.source === null ? data : new Uint8Array(),
      file.append,
    )
    file.opened = true
    if (file.source === null) {
      file.offset += data.byteLength
      return
    }
  }
  if (data.byteLength === 0) return
  if (file.source === null) {
    if (file.append) {
      await createFile(dispatch, session, file.scope, data, true)
    } else {
      await dispatch('pwrite', file.scope, [data, file.offset])
      file.offset += data.byteLength
    }
    return
  }
  const content = await materialize((await dispatch('read', file.scope))[0] as ByteSource)
  const offset = file.offset + file.source.lines.position
  const updated = spliceWindow(content, offset, data)
  await createFile(dispatch, session, file.scope, updated)
  file.offset = offset + data.byteLength
  file.source.lines = new AsyncLineIterator(updated.subarray(file.offset))
}

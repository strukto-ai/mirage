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

import { chunks } from '../../io/cooperative.ts'
import { OpReport, type ByteSource } from '../../io/types.ts'
import type { FileDescription } from '../../shell/descriptors.ts'
import {
  DEFAULT_UMASK,
  currentCaller,
  getCurrentEvaluation,
  type SessionOwner,
} from '../../context/session_context.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { isFsError } from '../../errors/fs.ts'
import { rechunk, sliceStream } from '../../io/stream.ts'
import { MEMORY_LIMIT } from '../../io/spool.ts'
import type { SessionState } from '../session/session.ts'
import { hasAborted, makeAbortError } from '../../utils/abort.ts'

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
 *
 * Returns the live pipe the open reached, directly or through a link, which
 * a descriptor goes on writing to whatever becomes of the name it was opened
 * by; null for anything else. Mirrors Python's create_file.
 */
export async function createFile(
  dispatch: DispatchFn,
  session: SessionState,
  scope: PathSpec,
  data: ByteSource,
  append = false,
): Promise<PathSpec | null> {
  let created = false
  if (session.umask !== DEFAULT_UMASK) {
    try {
      await dispatch('stat', scope)
    } catch (statErr) {
      if (!isFsError(statErr)) throw statErr
      created = true
    }
  }
  const report = new OpReport()
  await dispatch(append ? 'append' : 'write', scope, [data], {}, report)
  const pipe = await reachedPipe(dispatch, report.path)
  if (!created || pipe !== null) return pipe
  try {
    await dispatch('setattr', scope, [], { mode: 0o666 & ~session.umask })
  } catch (modeErr) {
    if (!isFsError(modeErr)) throw modeErr
  }
  return null
}

/** The live pipe a write ran on, null when it ran on anything else. Mirrors Python's _reached_pipe. */
async function reachedPipe(dispatch: DispatchFn, path: string | null): Promise<PathSpec | null> {
  if (!path?.startsWith('/dev/fd/')) return null
  const scope = PathSpec.fromStrPath(path)
  let stat: unknown
  try {
    ;[stat] = await dispatch('stat', scope)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`written descriptor ${path} is gone: ${String(err)}`)
    return null
  }
  return stat instanceof FileStat && stat.type === FileType.FIFO ? scope : null
}

/**
 * Write through a shared open description and advance its offset.
 *
 * A write-only description lands at its offset with one `pwrite`, so it
 * needs no read of the file, as a write to a write-only descriptor needs none
 * (`exec 3>f; echo a >&3`). Its first write into a file still empty lands as
 * one stream instead (`firstWrite`). A read-write one (`<>`) still reads it:
 * that description was opened to read, and its own reader resumes over what
 * the write left. Writes through one description take turns, the first one
 * (which opens the file) included, as the kernel orders writes to an open
 * file: a background job writing alongside the shell neither reopens the
 * file nor lands on an offset another write has not advanced yet. A writer
 * killed while it waits for its turn writes nothing: a promise cannot be
 * cancelled, so the turn checks the writer's execution frame, as
 * Python's cancelled task leaves the queue. What a killed command wrote
 * before it stopped (`kept`) still lands, as Python's task writes on once
 * it has taken its cancel.
 */
export async function writeDescription(
  dispatch: DispatchFn,
  session: SessionState,
  file: FileDescription,
  data: ByteSource,
  replace = false,
  kept = false,
): Promise<void> {
  if (file.emit !== null) {
    for await (const part of chunks(data)) await file.emit(part)
    return
  }
  const turn = file.writing
  let done = (): void => undefined
  file.writing = new Promise((resolve) => (done = resolve))
  try {
    await turn
    const writer = getCurrentEvaluation()?.frame.abortSignal ?? undefined
    if (!kept && hasAborted(writer)) throw makeAbortError(writer)
    if (file.source === null && (!file.opened || file.append || (replace && file.offset === 0))) {
      file.offset += await createCounted(dispatch, session, file.scope, data, file.append)
      file.opened = true
      return
    }
    if (
      file.source === null &&
      file.offset === 0 &&
      (await firstWrite(dispatch, session, file, data))
    ) {
      return
    }
    if (!file.opened) {
      await createFile(dispatch, session, file.scope, new Uint8Array(), file.append)
      file.opened = true
    }
    const start = file.offset + (file.source?.lines.position ?? 0)
    let offset = start
    try {
      for await (const part of rechunk(data, MEMORY_LIMIT)) {
        await dispatch('pwrite', file.scope, [part, offset])
        offset += part.byteLength
      }
    } finally {
      if (offset !== start) {
        file.offset = offset
        if (file.source !== null) {
          const content = (
            await dispatch('read', file.scope, [], { stream: true })
          )[0] as ByteSource
          file.source.lines = await file.source.lines.reopen(sliceStream(content, offset))
        }
      }
    }
  } finally {
    done()
  }
}

const streaming = new Map<SessionOwner | null, Set<string>>()

/**
 * Land an opened description's first write into a file still empty as one
 * stream, and answer whether it did. The same bytes from offset 0 in `pwrite`
 * windows cost a copy of the file each on a store whose `pwrite` rewrites it,
 * so `cmd > f` would move the file's size squared. The path is claimed in the
 * caller's workspace before the stat and kept until the stream ends, so
 * another description of the file writing meanwhile takes the windows, which
 * interleave as two descriptors do, instead of replacing what this one wrote;
 * another workspace's claims never touch it. A stream that fails leaves the
 * offset at what landed. `data` is untouched when this answers false. Mirrors
 * Python's _first_write.
 */
async function firstWrite(
  dispatch: DispatchFn,
  session: SessionState,
  file: FileDescription,
  data: ByteSource,
): Promise<boolean> {
  const owner = currentCaller().owner
  let held = streaming.get(owner)
  if (held === undefined) {
    held = new Set()
    streaming.set(owner, held)
  }
  const path = file.scope.virtual
  if (held.has(path)) return false
  held.add(path)
  try {
    if ((await sizeOf(dispatch, file.scope)) !== 0) return false
    try {
      file.offset = await createCounted(dispatch, session, file.scope, data)
    } catch (err) {
      file.offset = (await sizeOf(dispatch, file.scope)) ?? 0
      throw err
    }
    return true
  } finally {
    held.delete(path)
    if (held.size === 0) streaming.delete(owner)
  }
}

/** The size of the file a description opened, null when unknown. Mirrors Python's _size. */
async function sizeOf(dispatch: DispatchFn, scope: PathSpec): Promise<number | null> {
  let stat: unknown
  try {
    ;[stat] = await dispatch('stat', scope)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`write target ${scope.rawPath} has no stat: ${String(err)}`)
    return null
  }
  return stat instanceof FileStat ? stat.size : null
}

/** `createFile` that answers how many bytes it wrote. Mirrors Python's create_counted. */
async function createCounted(
  dispatch: DispatchFn,
  session: SessionState,
  scope: PathSpec,
  data: ByteSource,
  append = false,
): Promise<number> {
  if (data instanceof Uint8Array) {
    await createFile(dispatch, session, scope, data, append)
    return data.byteLength
  }
  let size = 0
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const part of chunks(data)) {
      size += part.byteLength
      yield part
    }
  }
  await createFile(dispatch, session, scope, counted(), append)
  return size
}

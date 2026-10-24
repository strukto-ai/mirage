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

import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { once } from 'node:events'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { ReadStream } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot } from './utils.ts'

export const FOLLOW =
  'test -f {path} && exec 3< {path} && command -v tail >/dev/null' +
  ' && echo && exec tail -n {n} -f <&3 3<&-'

async function waitForClose(rs: ReadStream): Promise<Error | null> {
  try {
    await once(rs, 'close')
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export async function* readChunks(rs: ReadStream): AsyncIterable<Uint8Array> {
  const closed = waitForClose(rs)
  let closeError: Error | null = null
  try {
    for await (const chunk of rs) {
      const buf = chunk as Buffer
      yield new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
  } finally {
    if (!rs.destroyed) rs.destroy()
    closeError = await closed
  }
  if (closeError !== null) throw closeError
}

export async function* readStream(accessor: SSHAccessor, p: PathSpec): AsyncIterable<Uint8Array> {
  const sftp = await accessor.sftp()
  const virtual = rawPathOf(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const rs = sftp.createReadStream(remote)
  const rec = recordStream('read', p.virtual, VFSName.SSH)
  try {
    for await (const chunk of readChunks(rs)) {
      if (rec !== null) rec.bytes += chunk.byteLength
      yield chunk
    }
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    throw err
  }
}

/**
 * The file's last `n` lines, then each line added to it, from `tail -f` on the
 * server over the mount's connection, so the file is not read again on each
 * poll.
 *
 * The server's shell opens the file itself and, once it holds it open and
 * finds a tail to run, says so with an empty line, and tail follows the
 * descriptor it opened, so the file the open found is the file followed.
 * Anything else (a server that runs no commands or has no tail, a missing or
 * unreadable file, a directory, a file gone before the open) leaves the file
 * to tail's poll, which reports it the way a failed open is reported and,
 * under `--retry`, waits for it. The bytes are the server tail's own: whole
 * lines, and the last line as it stands while the file has not ended it, as a
 * tail there prints them. Its wait for growth is its own, so `interval` goes
 * unused, and what it says on stderr (a truncation) is not shown. Mirrors
 * Python's `follow`.
 */
export async function follow(
  accessor: SSHAccessor,
  p: PathSpec,
  n: number,
  _interval: number,
): Promise<AsyncIterable<Uint8Array> | null> {
  const remote = singleQuote(joinRoot(accessor.config.root ?? '/', rawPathOf(p)))
  const command = FOLLOW.replaceAll(/\{path\}|\{n\}/g, (slot) =>
    slot === '{path}' ? remote : String(n),
  )
  const stream = accessor.runStream(command)
  let first: IteratorResult<Uint8Array>
  try {
    first = await stream.next()
  } catch (error) {
    console.debug(`ssh follow left to the poll: ${String(error)}`)
    await stream.return?.()
    return null
  }
  if (first.done === true || first.value[0] !== 0x0a) {
    await stream.return?.()
    return null
  }
  return followed(first.value.subarray(1), stream)
}

/**
 * `head`, then the rest of the server tail's output. An iterator rather than a
 * generator: a generator queues `return` behind a pull waiting for the next
 * line and runs nothing when closed before its first pull, and this one holds
 * the command open already, so `return` closes it at once, pulled or not.
 * Mirrors Python's `_Followed`.
 */
function followed(
  head: Uint8Array,
  stream: AsyncIterableIterator<Uint8Array>,
): AsyncIterableIterator<Uint8Array> {
  let pending: Uint8Array | null = head.byteLength > 0 ? head : null
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      if (pending === null) return stream.next()
      const value = pending
      pending = null
      return Promise.resolve({ value, done: false })
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      pending = null
      await stream.return?.()
      return done
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

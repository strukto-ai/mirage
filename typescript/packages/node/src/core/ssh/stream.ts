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

import { once } from 'node:events'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { ReadStream } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

export const FOLLOW =
  'test -f {path} && test -r {path} && command -v tail >/dev/null' +
  ' && echo && exec tail -n {n} -f -- {path}'

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
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const rs = sftp.createReadStream(remote)
  try {
    yield* readChunks(rs)
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
 * The shell runs tail only once it finds a regular file it can read at the
 * path and a tail to run, and says so with an empty line first; anything else
 * (a server that runs no commands or has no tail, a missing file, a directory)
 * leaves the file to tail's poll, which reports it. The bytes are the server
 * tail's own: whole lines, and the last line as it stands while the file has
 * not ended it, as a tail there prints them. The server's tail waits for
 * growth its own way (inotify where it has it), so `interval` goes unused, and
 * what it says on stderr (a truncation) is not shown. Mirrors Python's
 * `follow`.
 */
export async function follow(
  accessor: SSHAccessor,
  p: PathSpec,
  n: number,
  _interval: number,
): Promise<AsyncIterable<Uint8Array> | null> {
  const remote = singleQuote(joinRoot(accessor.config.root ?? '/', stripPrefix(p)))
  const command = FOLLOW.replaceAll('{path}', remote).replace('{n}', String(n))
  const stream = accessor.runStream(command)
  let first: IteratorResult<Uint8Array>
  try {
    first = await stream.next()
  } catch (error) {
    console.debug(`ssh follow left to the poll: ${String(error)}`)
    await stream.return(undefined)
    return null
  }
  if (first.done === true || first.value[0] !== 0x0a) {
    await stream.return(undefined)
    return null
  }
  return followed(first.value.subarray(1), stream)
}

/**
 * `head`, then the rest of `stream`, which closes however the caller stops.
 * Mirrors Python's `_followed`.
 */
async function* followed(
  head: Uint8Array,
  stream: AsyncGenerator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    if (head.byteLength > 0) yield head
    for (let next = await stream.next(); next.done !== true; next = await stream.next()) {
      yield next.value
    }
  } finally {
    await stream.return(undefined)
  }
}

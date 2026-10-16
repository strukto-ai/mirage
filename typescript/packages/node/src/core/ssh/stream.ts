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

export const FOLLOWABLE = 'test -f {path} && test -r {path} && command -v tail >/dev/null'
export const FOLLOW = 'exec tail -n {n} -f -- {path}'

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
 * One short command asks the server for a regular file it can read at the
 * path and a tail to run; anything else (a server that runs no commands or has
 * no tail, a missing file, a directory) leaves the file to tail's poll, which
 * reports it. The server's `tail -f` starts at the first pull and ends when
 * the stream closes, so a stream closed before it is pulled leaves nothing
 * running. The bytes are the server tail's own: whole lines, and the last line
 * as it stands while the file has not ended it, as a tail there prints them.
 * The server's tail waits for growth its own way (inotify where it has it), so
 * `interval` goes unused, and what it says on stderr (a truncation) is not
 * shown. Mirrors Python's `follow`.
 */
export async function follow(
  accessor: SSHAccessor,
  p: PathSpec,
  n: number,
  _interval: number,
): Promise<AsyncIterable<Uint8Array> | null> {
  const remote = singleQuote(joinRoot(accessor.config.root ?? '/', stripPrefix(p)))
  const fill = (template: string): string =>
    template.replaceAll(/\{path\}|\{n\}/g, (slot) => (slot === '{path}' ? remote : String(n)))
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(fill(FOLLOWABLE))
  } catch (error) {
    console.debug(`ssh follow left to the poll: ${String(error)}`)
    return null
  }
  if (status !== 0 || out.length > 0 || err.length > 0) return null
  return followed(accessor, fill(FOLLOW))
}

/**
 * The server tail's output, its command started at the first pull. An
 * iterator rather than a generator: a generator queues `return` behind a pull
 * waiting for the next line, so an idle `tail -f` could never close its
 * channel; `return` here closes it at once, and before the first pull leaves
 * nothing to close. Mirrors Python's `_followed`.
 */
function followed(accessor: SSHAccessor, command: string): AsyncIterableIterator<Uint8Array> {
  let stream: AsyncIterableIterator<Uint8Array> | null = null
  let closed = false
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      if (closed) return Promise.resolve(done)
      stream ??= accessor.runStream(command)
      return stream.next()
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      closed = true
      await stream?.return?.()
      return done
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

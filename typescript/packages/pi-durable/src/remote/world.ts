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

import { fsError } from '@struktoai/mirage-core/errors/fs'
import type { OutputEvent } from '@struktoai/mirage-core/io/types'
import {
  MirageClient,
  MirageRemoteError,
  type MirageRemote,
} from '@struktoai/mirage-core/remote/client'
import { BIN_PREFIX } from '@struktoai/mirage-core/shell/constants'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import { HISTORY_PREFIX } from '@struktoai/mirage-core/vfs/history/history'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import type { EnvExecution, EnvWorld } from '../world.ts'

// The window a streamed read asks for, and the batch a streamed write sends.
const CHUNK_BYTES = 1024 * 1024

// The output a streamed command may queue before the server's stream waits
// for the reader: the spill can lag behind a fast command without the queue
// growing past this.
const QUEUE_BYTES = 1024 * 1024

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

const AUTOMATIC_MOUNTS = ['/dev', prefixOf(HISTORY_PREFIX), prefixOf(BIN_PREFIX)]

/**
 * A line with `env` exported ahead of it, on its first line so the line
 * numbers the shell reports are the caller's. The server runs a line given a
 * `cwd` as a subshell, so the exports end with it.
 */
function withEnv(line: string, env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) return line
  for (const [key] of entries) {
    if (!SHELL_NAME.test(key))
      throw new Error(`mirage: environment name \`${key}\` is not a shell variable name`)
  }
  return `export ${entries.map(([key, value]) => `${key}=${singleQuote(value)}`).join(' ')}; ${line}`
}

function prefixOf(path: string): string {
  let end = path.length
  while (end > 1 && path.charCodeAt(end - 1) === 47) end -= 1
  return path.slice(0, end)
}

/**
 * One streamed command on the server, its chunks queued for one reader. The
 * queue is bounded: past `QUEUE_BYTES` the output handler waits for the
 * reader, so the server's stream waits too and memory holds at most that.
 */
class RemoteExecution implements EnvExecution {
  readonly events: AsyncIterable<OutputEvent>
  private readonly controller = new AbortController()
  private readonly queued: OutputEvent[] = []
  private readonly outcome: Promise<ExecuteResult>
  private wake: (() => void) | undefined
  private room: (() => void) | undefined
  private queuedBytes = 0
  private finished = false
  private stopped = false

  constructor(
    start: (
      signal: AbortSignal,
      onOutput: (stream: 'stdout' | 'stderr', data: Uint8Array) => Promise<void>,
    ) => Promise<ExecuteResult>,
    signal?: AbortSignal,
  ) {
    const signals =
      signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, signal])
    this.outcome = start(signals, async (stream, data) => {
      this.queued.push({ stream, data })
      this.queuedBytes += data.length
      this.notify()
      while (this.queuedBytes > QUEUE_BYTES && !this.stopped) {
        await new Promise<void>((resolve) => {
          this.room = resolve
        })
      }
    })
    const settle = (): void => {
      this.finished = true
      this.notify()
    }
    // The outcome is the caller's through `wait()`; this only ends the events.
    this.outcome.then(settle, settle)
    this.events = { [Symbol.asyncIterator]: () => this.drain() }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  private release(): void {
    const room = this.room
    this.room = undefined
    room?.()
  }

  private async *drain(): AsyncGenerator<OutputEvent> {
    try {
      for (;;) {
        const next = this.queued.shift()
        if (next !== undefined) {
          this.queuedBytes -= next.data.length
          if (this.queuedBytes <= QUEUE_BYTES) this.release()
          yield next
          continue
        }
        if (this.finished) return
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    } finally {
      // A reader that stops early never frees room, so the stream stops waiting.
      this.stopped = true
      this.release()
    }
  }

  wait(): Promise<ExecuteResult> {
    return this.outcome
  }

  cancel(): void {
    this.stopped = true
    this.release()
    this.controller.abort(new DOMException('canceled', 'AbortError'))
  }
}

/**
 * A workspace a Mirage server holds, as one session sees it: each file call
 * goes to the server's VFS API and each command to its shell.
 *
 * @param remote where the workspace lives and how to reach it.
 * @param sessionId the session every call acts as, created on first use;
 *   the default session when absent.
 * @param id Pi's file namespace; the server and workspace when absent, so
 *   every process reaching one workspace shares it.
 * @returns the world `MirageExecutionEnv` works in.
 */
export function remoteWorld(remote: MirageRemote, sessionId?: string, id?: string): EnvWorld {
  const client = new MirageClient(remote)
  let provisioned: Promise<void> | undefined
  // The session is created once, on the first call; one another client made
  // first is adopted.
  const ready = (): Promise<void> => {
    if (sessionId === undefined) return Promise.resolve()
    provisioned ??= client.createSession(sessionId).then(
      () => undefined,
      (err: unknown) => {
        if (err instanceof MirageRemoteError && err.status === 409) return
        provisioned = undefined
        throw err
      },
    )
    return provisioned
  }
  const call =
    <A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
    async (...args: A): Promise<T> => {
      await ready()
      return run(...args)
    }
  let mounts: Promise<string[]> | undefined
  // The server leaves the mounts every workspace has (`/dev`, the history and
  // program views) out of its mount list, so they are added back here.
  const prefixes = (): Promise<string[]> => {
    mounts ??= client.mounts().then(
      (found) => [...found.map((mount) => prefixOf(mount.prefix)), ...AUTOMATIC_MOUNTS],
      (err: unknown) => {
        mounts = undefined
        throw err
      },
    )
    return mounts
  }
  let freshKnown = true
  const encode = (data: string | Uint8Array): Uint8Array =>
    typeof data === 'string' ? new TextEncoder().encode(data) : data

  return {
    id: id ?? `mirage:${prefixOf(remote.url)}/${remote.workspace}`,
    files: {
      read: call((path: string) =>
        client.read(path, { ...(sessionId === undefined ? {} : { sessionId }) }),
      ),
      readStream: call((path: string) => {
        async function* windows(): AsyncGenerator<Uint8Array> {
          for (let offset = 0; ; offset += CHUNK_BYTES) {
            const chunk = await client.read(path, {
              offset,
              size: CHUNK_BYTES,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
            if (chunk.length > 0) yield chunk
            if (chunk.length < CHUNK_BYTES) return
          }
        }
        return Promise.resolve(windows())
      }),
      write: call((path: string, data: string | Uint8Array) =>
        client.write(path, encode(data), sessionId),
      ),
      writeStream: call(async (path: string, chunks: AsyncIterable<Uint8Array>) => {
        // The chunks are read as they come and never wait on the server: a
        // write the server holds (a workspace capture waits out running
        // lines) must not stall the line whose output this is, or neither
        // ends. Requests go out one at a time and carry at most a batch, the
        // first replacing the file and the rest appending; only a held
        // request lets what waits behind it grow past one batch.
        const pending = { chunks: [] as Uint8Array[], held: 0, started: false }
        let inFlight: Promise<void> | undefined
        let failure: { error: unknown } | undefined
        const take = (): Uint8Array => {
          const size = Math.min(pending.held, CHUNK_BYTES)
          const out = new Uint8Array(size)
          let at = 0
          while (at < size) {
            const [head] = pending.chunks
            if (head === undefined) break
            const part = head.subarray(0, size - at)
            out.set(part, at)
            at += part.length
            if (part.length === head.length) pending.chunks.shift()
            else pending.chunks[0] = head.subarray(part.length)
          }
          pending.held -= size
          return out
        }
        const send = (): void => {
          const batch = take()
          const replace = !pending.started
          pending.started = true
          inFlight = (
            replace ? client.write(path, batch, sessionId) : client.append(path, batch, sessionId)
          ).then(
            () => {
              inFlight = undefined
              if (pending.held >= CHUNK_BYTES && failure === undefined) send()
            },
            (error: unknown) => {
              inFlight = undefined
              failure = { error }
            },
          )
        }
        for await (const chunk of chunks) {
          if (failure !== undefined) throw failure.error
          pending.chunks.push(chunk)
          pending.held += chunk.length
          if (pending.held >= CHUNK_BYTES && inFlight === undefined) send()
        }
        for (;;) {
          while (inFlight !== undefined) await inFlight
          if (failure !== undefined) throw failure.error
          if (pending.started && pending.held === 0) return
          send()
        }
      }),
      append: call((path: string, data: Uint8Array) => client.append(path, data, sessionId)),
      stat: call(async (path: string, options: { nofollow?: boolean; fresh?: boolean } = {}) => {
        const nofollow = options.nofollow === true
        if (options.fresh !== true || !freshKnown) {
          return client.stat(path, sessionId, undefined, { nofollow })
        }
        try {
          return await client.stat(path, sessionId, undefined, { nofollow, fresh: true })
        } catch (err) {
          // A server older than `fresh` refuses it; the cached row is then the best it has.
          if (!(err instanceof MirageRemoteError && err.code === 'unknown_field')) throw err
          freshKnown = false
          return client.stat(path, sessionId, undefined, { nofollow })
        }
      }),
      readdir: call((path: string) => client.readdir(path, sessionId)),
      exists: call((path: string) => client.exists(path, sessionId)),
      isDir: call((path: string) => client.isDir(path, sessionId)),
      mkdir: call((path: string) => client.mkdir(path, sessionId)),
      rmdir: call((path: string) => client.rmdir(path, sessionId)),
      unlink: call((path: string) => client.unlink(path, sessionId)),
      truncate: call((path: string, length: number) => client.truncate(path, length, sessionId)),
      rename: call((source: string, destination: string) =>
        client.rename(source, destination, sessionId),
      ),
      readlink: call(async (path: string) => {
        const target = await client.readlink(path, sessionId)
        if (target === null) throw fsError(path, 'EINVAL', 'not a symbolic link')
        return target
      }),
      holdsMount: async (path: string) => {
        const own = prefixOf(path)
        const under = own === '/' ? '/' : `${own}/`
        return (await prefixes()).some((prefix) => prefix === own || prefix.startsWith(under))
      },
    },
    shell: {
      run: call((line: string, options: { cwd?: string } = {}) =>
        client.shell(line, {
          record: false,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
      ),
      stream: call(
        (
          line: string,
          options: { cwd: string; env?: Record<string, string>; signal?: AbortSignal },
        ) => {
          const command = withEnv(line, options.env)
          // The server's shell request has no environment, so the values ride
          // in the line's text; a line carrying any stays out of the
          // session's history, where a token would outlive the command.
          const secret = command !== line
          return Promise.resolve<EnvExecution>(
            new RemoteExecution(
              (signal, onOutput) =>
                client.shell(command, {
                  cwd: options.cwd,
                  signal,
                  onOutput,
                  ...(secret ? { record: false } : {}),
                  ...(sessionId === undefined ? {} : { sessionId }),
                }),
              options.signal,
            ),
          )
        },
      ),
    },
  }
}

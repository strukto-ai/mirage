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
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import type { EnvExecution, EnvWorld } from '../world.ts'

// The window a streamed read asks for, and the batch a streamed write sends.
const CHUNK_BYTES = 1024 * 1024

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

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

/** One streamed command on the server, its chunks queued for one reader. */
class RemoteExecution implements EnvExecution {
  readonly events: AsyncIterable<OutputEvent>
  private readonly controller = new AbortController()
  private readonly queued: OutputEvent[] = []
  private readonly outcome: Promise<ExecuteResult>
  private wake: (() => void) | undefined
  private finished = false

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
    this.outcome = start(signals, (stream, data) => {
      this.queued.push({ stream, data })
      this.notify()
      return Promise.resolve()
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

  private async *drain(): AsyncGenerator<OutputEvent> {
    for (;;) {
      const next = this.queued.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  wait(): Promise<ExecuteResult> {
    return this.outcome
  }

  cancel(): void {
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
  const prefixes = (): Promise<string[]> => {
    mounts ??= client.mounts().then(
      (found) => found.map((mount) => prefixOf(mount.prefix)),
      (err: unknown) => {
        mounts = undefined
        throw err
      },
    )
    return mounts
  }
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
        // The first batch replaces the file and the rest append, so a long
        // stream never sits in memory whole.
        const pending = { batch: [] as Uint8Array[], held: 0, started: false }
        const flush = async (): Promise<void> => {
          const joined = new Uint8Array(pending.held)
          let at = 0
          for (const chunk of pending.batch) {
            joined.set(chunk, at)
            at += chunk.length
          }
          const replace = !pending.started
          pending.batch = []
          pending.held = 0
          pending.started = true
          if (replace) await client.write(path, joined, sessionId)
          else await client.append(path, joined, sessionId)
        }
        for await (const chunk of chunks) {
          pending.batch.push(chunk)
          pending.held += chunk.length
          if (pending.held >= CHUNK_BYTES) await flush()
        }
        if (!pending.started || pending.held > 0) await flush()
      }),
      append: call((path: string, data: Uint8Array) => client.append(path, data, sessionId)),
      stat: call((path: string, options: { nofollow?: boolean } = {}) =>
        client.stat(path, sessionId, undefined, { nofollow: options.nofollow === true }),
      ),
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
          return Promise.resolve<EnvExecution>(
            new RemoteExecution(
              (signal, onOutput) =>
                client.shell(command, {
                  cwd: options.cwd,
                  signal,
                  onOutput,
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

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

import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { Readable, type Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import {
  EXEC_PRELUDE,
  PIPE_DIAGNOSTIC_BYTES,
  PIPE_DIAGNOSTIC_WAIT_SECONDS,
} from '@struktoai/mirage-core/runtime/sandbox/constants'
import { debuglog } from 'node:util'
import { asyncChain, closeQuietly } from '@struktoai/mirage-core/io/stream'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { makeAbortError } from '@struktoai/mirage-core/utils/abort'

export interface CliResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

/** Where and how `runCli` starts its child. */
export interface CliOptions {
  // The working directory; this process's when unset.
  cwd?: string
  // The whole environment; this process's when unset.
  env?: Record<string, string>
  // Aborting kills the child and everything it started.
  signal?: AbortSignal
  // Where the child is kept while it runs, for `closeChildren`.
  children?: Set<ChildProcess>
  output?: (chunk: Uint8Array) => Promise<void>
}

async function untilInputCloses<T>(
  stream: Writable,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  if (stream.destroyed) return null
  const controller = new AbortController()
  const closed = once(stream, 'close', { signal: controller.signal }).then(() => null)
  try {
    return await Promise.race([work(controller.signal), closed])
  } finally {
    controller.abort()
  }
}

/**
 * One process run to its end: its output and its exit status. The child
 * leads a process group of its own, and an aborted call kills the whole
 * group and stops reading the pipes: a grandchild left alive, or one that
 * left the group, holds the output pipes open, so 'close' would wait until
 * it exited on its own, and the call rejects with an AbortError at once. A
 * missing executable rejects with `hint` when one is given, else with
 * spawn's own error. EPIPE means the command exited without draining its
 * stdin (`head`-like), so it is not an error. An input pull still pending
 * when the child exits is left to close on its own. Mirrors Python's
 * `run_cli`.
 */
export async function runCli(
  executable: string,
  hint: string | null,
  args: string[],
  stdin: ByteSource | null,
  options: CliOptions = {},
): Promise<CliResult> {
  const { signal, children } = options
  signal?.throwIfAborted()
  const child = spawn(executable, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const abort = (): void => {
    stopTree(child)
  }
  signal?.addEventListener('abort', abort, { once: true })
  children?.add(child)
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' && hint !== null ? new Error(hint) : error)
    })
    child.once('close', (code, name) => {
      children?.delete(child)
      resolve(code ?? (name === null ? 1 : 128 + constants.signals[name]))
    })
  })
  // A failed spawn can arrive before its output readers finish.
  void exited.catch(() => undefined)
  const source = asyncChain([stdin])[Symbol.asyncIterator]()
  const inputState = { ended: false, pulling: false }
  const inputHasEnded = (): boolean => inputState.ended
  child.stdin.once('close', () => {
    inputState.ended = true
  })
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    debuglog('mirage')('process stdin closed: %s', error)
  })
  const feeding = (async () => {
    try {
      while (!inputHasEnded()) {
        inputState.pulling = true
        const next = await untilInputCloses(child.stdin, () => source.next())
        if (next !== null) inputState.pulling = false
        if (next === null || next.done === true || inputHasEnded()) break
        if (!child.stdin.write(next.value))
          await untilInputCloses(child.stdin, (signal) => once(child.stdin, 'drain', { signal }))
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE' && !inputState.ended) throw err
      debuglog('mirage')('process closed input: %s', err)
    } finally {
      child.stdin.end()
    }
  })()
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []
  const reading = (async () => {
    try {
      for await (const chunk of child.stdout) {
        if (options.output === undefined) out.push(chunk as Uint8Array)
        else await options.output(chunk as Uint8Array)
      }
    } catch (error) {
      if (!child.killed && child.signalCode === null && signal?.aborted !== true) throw error
      debuglog('mirage')('process output closed: %s', error)
    }
  })()
  const errors = (async () => {
    try {
      for await (const chunk of child.stderr) err.push(chunk as Uint8Array)
    } catch (error) {
      if (!child.killed && child.signalCode === null && signal?.aborted !== true) throw error
      debuglog('mirage')('process stderr closed: %s', error)
    }
  })()
  const pumps = Promise.all([reading, errors, feeding])
  try {
    await pumps
    const code = await exited
    if (signal?.aborted === true) throw makeAbortError(signal)
    return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), code }
  } finally {
    if (child.exitCode === null && child.signalCode === null) stopTree(child)
    child.stdin.destroy()
    await Promise.allSettled([pumps, exited])
    if (inputState.pulling) void closeQuietly(stdin)
    else await closeQuietly(stdin)
    signal?.removeEventListener('abort', abort)
    children?.delete(child)
  }
}

/**
 * A sandbox CLI's exec arguments, the same for every CLI that runs a
 * command in a box: the CLI's own words (`head`: `exec -i`, smolvm's
 * `machine exec --name M`), `/` as the working directory and each
 * variable as `-e`, the target or `--` (`tail`: `--` where the command is
 * a trailing var arg, so a line starting with a dash is not read as a
 * flag), then the command.
 *
 * A `cwd` runs the command there through the prelude, which exits 126
 * when the box lacks it, and defers the chdir until the shell starts, so
 * an agent that blocks on a chdir into a passive sshfs prefix still
 * serves the mount's pipe. Null runs it from `/` as given, for a helper
 * pipe. Mirrors Python's `exec_args`.
 */
export function execArgs(
  head: readonly string[],
  tail: readonly string[],
  env: Record<string, string>,
  cwd: string | null,
  argv: readonly string[],
): string[] {
  const args = [...head, '-w', '/']
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push(...tail)
  if (cwd !== null) args.push('/bin/sh', '-c', EXEC_PRELUDE, 'sh', cwd)
  return [...args, ...argv]
}

/**
 * Refuse a host program whose working directory this host lacks. The
 * session cwd is a workspace path; running elsewhere instead would point
 * a relative path at the wrong files. Mirrors Python's `cwd_refusal`.
 */
export async function cwdRefusal(name: string, cwd: string): Promise<RunResult | null> {
  const here = await stat(cwd).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === undefined) throw err
    debuglog('mirage')('cannot use %s as the working directory: %s', cwd, err)
    return null
  })
  if (here?.isDirectory() === true) return null
  return {
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(`${name}: the working directory ${cwd} is not on this host\n`),
    exitCode: 126,
  }
}

/**
 * Kill a child and everything it started: its process group. Windows has
 * no process group to kill, so only the child goes there. Mirrors Python's
 * `kill_tree`.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || process.platform === 'win32') {
    child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
    child.kill('SIGKILL')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    debuglog('mirage')('process group %d has already exited', child.pid)
  }
}

/**
 * Kill a child's tree and stop reading its pipes, which a descendant that
 * left the group (a session of its own) survives the kill holding; 'close'
 * comes once the child exits. Mirrors Python's `stop_tree`.
 */
function stopTree(child: ChildProcess): void {
  killTree(child)
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/**
 * Kill every child still running, so none outlives the workspace, and wait
 * for each to close. Mirrors Python's `close_children`.
 */
export async function closeChildren(children: Set<ChildProcess>): Promise<void> {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => {
            resolve()
          })
          stopTree(child)
        }),
    ),
  )
}

/**
 * Hold a byte transport to a sandbox helper until stopped. The tail of what
 * the helper says on stderr is kept for `diagnostic`, so a mount that fails
 * can say why. Stopping ends the helper's input; one that has not closed
 * 100 ms later loses its process group and our ends of its pipes, which
 * output nobody read would otherwise hold open, exited or not. Mirrors
 * Python's `open_cli_pipe`.
 */
export function openCliPipe(executable: string, args: string[]): Promise<SandboxPipe> {
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let said = Buffer.alloc(0)
  child.stderr.on('data', (chunk: Buffer) => {
    said = Buffer.concat([said, chunk]).subarray(-PIPE_DIAGNOSTIC_BYTES)
  })
  child.stderr.on('error', (err) => {
    debuglog('mirage')('%s helper stderr closed: %s', executable, err)
  })
  child.stdin.on('error', (err) => {
    debuglog('mirage')('%s helper stdin closed: %s', executable, err)
  })
  const exited = once(child, 'close').then(
    () => true,
    (err: unknown) => {
      debuglog('mirage')('%s helper failed: %s', executable, err)
      return true
    },
  )
  return Promise.resolve({
    reader: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    writer: child.stdin,
    diagnostic: async () => {
      await Promise.race([
        exited,
        delay(PIPE_DIAGNOSTIC_WAIT_SECONDS * 1000, false, { ref: false }),
      ])
      return said.toString('utf8').trim()
    },
    stop: async () => {
      child.stdin.end()
      if (!(await Promise.race([exited, delay(100, false, { ref: false })]))) stopTree(child)
      await exited
    },
  })
}

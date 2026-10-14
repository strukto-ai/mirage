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
import { debuglog } from 'node:util'
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
}

/**
 * One process run to its end: its output and its exit status. The child
 * leads a process group of its own, and an aborted call kills the whole
 * group and stops reading the pipes: a grandchild left alive, or one that
 * left the group, holds the output pipes open, so 'close' would wait until
 * it exited on its own, and the call rejects with an AbortError at once. A missing executable rejects with
 * `hint` when one is given, else with spawn's own error. EPIPE means the
 * command exited without draining its stdin (`head`-like); python's
 * communicate() suppresses the matching BrokenPipeError, so it is not an
 * error here either. Mirrors Python's `run_cli`.
 */
export function runCli(
  executable: string,
  hint: string | null,
  args: string[],
  stdin: Uint8Array | null,
  options: CliOptions = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const { signal, children } = options
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
    if (signal?.aborted === true) abort()
    children?.add(child)
    const settle = (): void => {
      signal?.removeEventListener('abort', abort)
      children?.delete(child)
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle()
      reject(error.code === 'ENOENT' && hint !== null ? new Error(hint) : error)
    })
    child.on('close', (code) => {
      settle()
      if (signal?.aborted === true) {
        reject(makeAbortError(signal))
        return
      }
      resolve({
        stdout: new Uint8Array(Buffer.concat(out)),
        stderr: new Uint8Array(Buffer.concat(err)),
        code: code ?? 1,
      })
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    if (stdin !== null) child.stdin.write(stdin)
    child.stdin.end()
  })
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

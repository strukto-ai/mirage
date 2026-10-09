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
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { PythonRuntime } from '@struktoai/mirage-core/runtime/python/base'
import { prepareSource } from '@struktoai/mirage-core/runtime/python/execution'
import { initArgv, type InitFlags } from '@struktoai/mirage-core/runtime/python/flags'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { RunArgs, RunResult, RuntimeOptions } from '@struktoai/mirage-core/runtime/types'
import { LOCAL_CONFIG_KEYS, type LocalConfig } from './config.ts'

const LOCAL_HOME_ENV = 'MIRAGE_LOCAL_HOME'

/**
 * Where the host's own PATH finds an interpreter, as Python's `shutil.which`
 * finds the twin's: the program's environment carries no host PATH, so the
 * lookup cannot be left to spawn. A name with a slash is taken as given, and
 * one the PATH lacks too, so spawn reports it missing.
 */
function onHostPath(name: string): string {
  if (name.includes('/')) return name
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === undefined) throw err
    }
  }
  return name
}

/**
 * Run Python code on a host interpreter as a subprocess.
 *
 * Each run spawns `<interpreter> -c <code>`; the code sees the host
 * filesystem, not the workspace mounts. Its environment is the session's
 * and the config `env`, nothing of mirage's own, as a sandlock child
 * gets. Mirrors the
 * python LocalRuntime: the interpreter defaults to `python3` on PATH
 * (node has no embedded python, unlike the python package which
 * defaults to its own interpreter); point the config `home` or the
 * MIRAGE_LOCAL_HOME environment variable at another binary, e.g. a
 * project venv whose packages the code needs.
 */
export class LocalRuntime extends PythonRuntime {
  readonly name = 'local'
  // Spawns the host interpreter: a real process with the user's own
  // filesystem and network, doors the workspace gate never sees. This
  // is the base default; declared here so the claim is explicit at the
  // one builtin runtime that voids a world's sandbox claim.
  override readonly reach = 'process'
  private readonly python: string
  private readonly children = new Set<ChildProcess>()

  constructor(options: RuntimeOptions = {}) {
    super(options, LOCAL_CONFIG_KEYS)
    const home = (this.config as LocalConfig).home
    const chosen = home !== undefined && home !== '' ? home : process.env[LOCAL_HOME_ENV]
    this.python = onHostPath(chosen !== undefined && chosen !== '' ? chosen : 'python3')
  }

  override version(_env: Record<string, string>, signal?: AbortSignal): Promise<RunResult> {
    // Session loader variables can execute code before --version is read.
    return this.runProcess(['--version'], {}, null, signal)
  }

  run(args: RunArgs): Promise<RunResult> {
    // Honoring the init switches is just handing them back to the real
    // interpreter, which is why this tier gets them exactly right
    // (sys.flags included) where an in-process engine cannot.
    return this.runProcess(
      [...initArgv((args.flags ?? {}) as InitFlags), '-c', prepareSource(args), ...args.args],
      args.env,
      args.stdin,
      args.signal,
    )
  }

  private runProcess(
    argv: string[],
    env: Record<string, string>,
    stdin: Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // The signal aborts when the command's limit timeout trips:
      // spawn then SIGKILLs the child (matching the python runtime's
      // proc.kill() on cancellation) and 'close' settles the promise.
      const child = spawn(this.python, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...(this.config as LocalConfig).env, ...env },
        ...(signal !== undefined ? { signal, killSignal: 'SIGKILL' } : {}),
      })
      this.children.add(child)
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.name === 'AbortError') return
        this.children.delete(child)
        reject(
          error.code === 'ENOENT'
            ? new Error(
                `local python interpreter not found: '${this.python}' (set the ` +
                  `runtime entry's config home or ${LOCAL_HOME_ENV})`,
              )
            : error,
        )
      })
      child.on('close', (code) => {
        this.children.delete(child)
        const stderr = Buffer.concat(err)
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: stderr.length > 0 ? new Uint8Array(stderr) : null,
          exitCode: code ?? 1,
        })
      })
      // EPIPE means the program exited without draining its stdin
      // (`head`-like); python's communicate() suppresses the matching
      // BrokenPipeError, so it is not an error here either.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      if (stdin !== null) child.stdin.write(stdin)
      child.stdin.end()
    })
  }

  override close(): Promise<void> {
    for (const child of this.children) child.kill('SIGKILL')
    this.children.clear()
    return Promise.resolve()
  }
}

registerRuntime('local', LocalRuntime)

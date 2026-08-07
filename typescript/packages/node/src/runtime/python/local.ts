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
import {
  PythonRuntime,
  registerRuntime,
  type RunArgs,
  type RunResult,
  type RuntimeOptions,
} from '@struktoai/mirage-core'

const LOCAL_HOME_ENV = 'MIRAGE_LOCAL_HOME'
const LOCAL_CONFIG_KEYS: readonly string[] = ['home']

/**
 * Run Python code on a host interpreter as a subprocess.
 *
 * Each run spawns `<interpreter> -c <code>`; the code sees the host
 * filesystem and environment, not the workspace mounts. Mirrors the
 * python LocalRuntime: the interpreter defaults to `python3` on PATH
 * (node has no embedded python, unlike the python package which
 * defaults to its own interpreter); point the config `home` or the
 * MIRAGE_LOCAL_HOME environment variable at another binary, e.g. a
 * project venv whose packages the code needs.
 */
export class LocalRuntime extends PythonRuntime {
  readonly name = 'local'
  static readonly commands: readonly string[] = ['python3', 'python'] as const
  private readonly python: string
  private readonly children = new Set<ChildProcess>()

  constructor(options: RuntimeOptions = {}) {
    super(options, LocalRuntime.commands, LOCAL_CONFIG_KEYS)
    const home = (this.config as { home?: string }).home
    const chosen = home !== undefined && home !== '' ? home : process.env[LOCAL_HOME_ENV]
    this.python = chosen !== undefined && chosen !== '' ? chosen : 'python3'
  }

  run(args: RunArgs): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // The signal aborts when the command's limit timeout trips:
      // spawn then SIGKILLs the child (matching the python runtime's
      // proc.kill() on cancellation) and 'close' settles the promise.
      const child = spawn(this.python, ['-c', args.code, ...args.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...args.env },
        ...(args.signal !== undefined ? { signal: args.signal, killSignal: 'SIGKILL' } : {}),
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
      if (args.stdin !== null) child.stdin.write(args.stdin)
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

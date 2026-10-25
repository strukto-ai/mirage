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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { debuglog } from 'node:util'
import { fsStrerror } from '@struktoai/mirage-core/errors/fs'
import { resolveHome, type RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { PROCESS_EXECUTOR, type ProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { PythonRuntime } from '@struktoai/mirage-core/runtime/python/base'
import { prepareSource } from '@struktoai/mirage-core/runtime/python/execution'
import { initArgv } from '@struktoai/mirage-core/runtime/python/flags'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { OutputFn, Program, RunResult } from '@struktoai/mirage-core/runtime/types'
import { LOCAL_CONFIG_KEYS, type LocalConfig } from './config.ts'
import { closeChildren, cwdRefusal, onHostPath, runProgram } from '../../sandbox/program.ts'

const LOCAL_HOME_ENV = 'MIRAGE_LOCAL_HOME'

/**
 * Whether a resolved program is an executable file. Asynchronous, as is
 * every check `runProcess` makes, so a path on this process's own FUSE
 * folder never blocks the loop that answers it.
 */
async function isExecutable(program: string): Promise<boolean> {
  if (!isAbsolute(program)) return false
  try {
    if (!(await stat(program)).isFile()) return false
    await access(program, constants.X_OK)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === undefined) throw err
    debuglog('mirage')(
      'local: %s is not executable: %s',
      program,
      (err as NodeJS.ErrnoException).code,
    )
    return false
  }
}

/**
 * Why a program named by a path cannot run, in the shell's words and exit
 * code; null when it can.
 */
async function unrunnable(name: string, path: string): Promise<RunResult | null> {
  const found = await stat(path).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === undefined) throw err
    debuglog('mirage')('local: cannot stat %s: %s', path, code)
    return null
  })
  if (found === null) return notRun(`${name}: No such file or directory\n`, 127)
  if (found.isDirectory()) return notRun(`${name}: Is a directory\n`, 126)
  const runs = await access(path, constants.X_OK).then(
    () => true,
    (err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === undefined) throw err
      debuglog('mirage')('local: cannot execute %s: %s', path, code)
      return false
    },
  )
  return runs ? null : notRun(`${name}: Permission denied\n`, 126)
}

/** A program that never started: its message and exit code. */
function notRun(message: string, exitCode: number): RunResult {
  return { stdout: new Uint8Array(), stderr: new TextEncoder().encode(message), exitCode }
}

/**
 * Run Python code, and any other captured program, on the host.
 *
 * Each python3 run spawns `<interpreter> -c <code>`. Any other name the
 * captures send here (a named program, or EXTERNAL_COMMANDS) runs as its
 * argv, found on the host PATH, with no shell, in the session cwd. Either
 * way the program sees the host filesystem, not the workspace mounts. Its
 * environment is the session's and the config `env`, nothing of mirage's
 * own, as a sandlock child gets. Mirrors the python LocalRuntime: the
 * interpreter defaults to
 * `python3` on PATH (node has no embedded python, unlike the python
 * package which defaults to its own interpreter); point the config `home`
 * or the MIRAGE_LOCAL_HOME environment variable at another binary, e.g. a
 * project venv whose packages the code needs.
 */
export class LocalRuntime extends PythonRuntime<undefined> implements ProcessExecutor<undefined> {
  readonly name = 'local'
  readonly [PROCESS_EXECUTOR] = true as const
  // Spawns the host interpreter: a real process with the user's own
  // filesystem and network, entry points the workspace gate never sees. This
  // is the base default; declared here so the claim is explicit at the
  // one builtin runtime that voids a world's sandbox claim.
  override readonly reach = 'process'
  private readonly home: string | undefined
  private readonly python: Promise<string>
  private readonly children = new Set<ChildProcess>()
  private closed = false

  constructor(options: RuntimeOptions = {}) {
    super(options, LOCAL_CONFIG_KEYS)
    this.home = resolveHome(this.config as LocalConfig, LOCAL_HOME_ENV)
    // A configured path is read from the directory the entry is built in,
    // as Python's twin makes it absolute; a name is found on the PATH as
    // the entry is built, without blocking the loop, and a run that finds
    // nothing there says so.
    const home = this.home?.includes('/') === true ? resolve(this.home) : this.home
    this.python = onHostPath(home ?? 'python3')
    void this.python.catch(() => undefined)
    if (home?.includes('/') === true) {
      try {
        accessSync(home, constants.X_OK)
      } catch (cause) {
        throw new Error(
          `local python interpreter not found: ${home} (from the runtime entry's config home or ${LOCAL_HOME_ENV})`,
          { cause },
        )
      }
    }
  }

  override async version(_env: Record<string, string>, signal?: AbortSignal): Promise<RunResult> {
    // Session loader variables can execute code before --version is read.
    return this.spawnProgram(await this.interpreter(), ['--version'], {}, null, signal)
  }

  async interpret(
    _engine: undefined,
    program: Program,
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    // Honoring the init switches is just handing them back to the real
    // interpreter, which is why this tier gets them exactly right
    // (sys.flags included) where an in-process engine cannot.
    return this.spawnProgram(
      await this.interpreter(),
      [...initArgv(ctx.flags), '-c', prepareSource(program, ctx.cwd), ...program.args],
      ctx.env ?? {},
      program.stdin,
      ctx.signal,
      undefined,
      output,
      errors,
    )
  }

  async runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    argv: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    ctx.signal?.throwIfAborted()
    const name = argv[0] ?? ''
    const cwd = ctx.cwd.virtual
    const refusal = await cwdRefusal(name, cwd)
    if (refusal !== null) return refusal
    let program: string
    if (name.includes('/')) {
      // A name with a slash is a path from the cwd, as in the shell.
      // Joined, not resolved, so the host follows a `..` past a symlink
      // as written.
      program = isAbsolute(name) ? name : `${rstripSlash(cwd)}/${name}`
      const refusal = await unrunnable(name, program)
      if (refusal !== null) return refusal
    } else {
      program = await onHostPath(name)
      if (!(await isExecutable(program))) return notRun(`${name}: command not found\n`, 127)
    }
    // A program that cannot start (its script's interpreter missing, say)
    // fails as the shell's would, so `tool || fallback` goes on.
    return this.spawnProgram(
      program,
      argv.slice(1),
      ctx.env ?? {},
      ctx.stdin,
      ctx.signal,
      cwd,
      output,
      errors,
    ).catch((err: unknown) => {
      const { code, syscall } = err as NodeJS.ErrnoException
      if (code === undefined || syscall?.startsWith('spawn') !== true) throw err
      return notRun(`${name}: cannot execute: ${fsStrerror(err) ?? code}\n`, 126)
    })
  }

  /** The interpreter the host PATH found, refused when it found none. */
  private async interpreter(): Promise<string> {
    const name = this.home ?? 'python3'
    const found = await this.python
    if (!(await isExecutable(found)))
      throw new Error(
        `local python interpreter not found: '${name}' (set the ` +
          `runtime entry's config home or ${LOCAL_HOME_ENV})`,
      )
    return found
  }

  private spawnProgram(
    program: string,
    argv: string[],
    env: Record<string, string>,
    stdin: ByteSource | null,
    signal?: AbortSignal,
    cwd?: string,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    // A run still finding its program when the runtime closed starts
    // nothing, so no child outlives the close.
    if (this.closed) return Promise.reject(new Error(`${this.name}: the runtime is closed`))
    return runProgram(program, null, argv, stdin, {
      env: { ...(this.config as LocalConfig).env, ...env },
      children: this.children,
      direct: true,
      ...(output === undefined ? {} : { output }),
      ...(errors === undefined ? {} : { errors }),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  override close(): Promise<void> {
    this.closed = true
    return closeChildren(this.children)
  }
}

registerRuntime('local', LocalRuntime)

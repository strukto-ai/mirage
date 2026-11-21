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
import { missingProgram } from '@struktoai/mirage-core/context/session_context'
import { MachineName } from '@struktoai/mirage-core/execution/types'
import { HOST } from '@struktoai/mirage-core/runtime/constants'
import {
  resolveHome,
  type ConfigFields,
  type RuntimeOptions,
} from '@struktoai/mirage-core/runtime/config'
import { PROCESS_EXECUTOR, type ProcessExecutorMixin } from '@struktoai/mirage-core/runtime/mixin'
import { PythonRuntime } from '@struktoai/mirage-core/runtime/python/base'
import { prepareSource } from '@struktoai/mirage-core/runtime/python/execution'
import { initArgv } from '@struktoai/mirage-core/runtime/python/flags'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { OutputFn, Program, RunResult } from '@struktoai/mirage-core/runtime/types'
import { LocalConfig } from './config.ts'
import {
  closeChildren,
  cwdRefusal,
  onHostPath,
  runProgram,
  systemTimeEnv,
} from '../../../machine/program.ts'
import { CANNOT_EXECUTE_STATUS, NOT_FOUND_STATUS } from '@struktoai/mirage-core/shell/constants'

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
async function unrunnable(path: string): Promise<readonly [string, number] | null> {
  const found = await stat(path).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === undefined) throw err
    debuglog('mirage')('local: cannot stat %s: %s', path, code)
    return null
  })
  if (found === null) return ['No such file or directory', NOT_FOUND_STATUS]
  if (found.isDirectory()) return ['Is a directory', CANNOT_EXECUTE_STATUS]
  const runs = await access(path, constants.X_OK).then(
    () => true,
    (err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === undefined) throw err
      debuglog('mirage')('local: cannot execute %s: %s', path, code)
      return false
    },
  )
  return runs ? null : ['Permission denied', CANNOT_EXECUTE_STATUS]
}

/** A program that never started: its message, said on `errors`, and exit code. */
async function notRun(errors: OutputFn, message: string, exitCode: number): Promise<RunResult> {
  await errors(new TextEncoder().encode(message))
  return { exitCode }
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
export class LocalRuntime
  extends PythonRuntime<undefined>
  implements ProcessExecutorMixin<undefined>
{
  static override readonly configFields: ConfigFields = LocalConfig
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
    super(options, LocalRuntime.configFields)
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
          `local python interpreter not found: ${home} (from the machine's \`home\` or ${LOCAL_HOME_ENV})`,
          { cause },
        )
      }
    }
  }

  /** The host, under the name of the machine entry that runs it. Mirrors Python's `machine`. */
  override get machine(): MachineName {
    return new MachineName(HOST, this.name)
  }

  override async version(
    _env: Record<string, string>,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    // Session loader variables can execute code before --version is read.
    return this.spawnProgram(
      await this.interpreter(),
      ['--version'],
      {},
      null,
      output,
      errors,
      signal,
    )
  }

  async interpret(
    _engine: undefined,
    program: Program,
    ctx: Context,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    // Honoring the init switches is just handing them back to the real
    // interpreter, which is why this tier gets them exactly right
    // (sys.flags included) where an in-process engine cannot.
    return this.spawnProgram(
      await this.interpreter(),
      [...initArgv(ctx.flags), '-c', prepareSource(program, ctx.cwd), ...program.args],
      ctx.env ?? {},
      program.stdin,
      output,
      errors,
      ctx.signal,
    )
  }

  async runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    argv: string[],
    ctx: Context,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    ctx.signal?.throwIfAborted()
    const name = argv[0] ?? ''
    const cwd = ctx.cwd.virtual
    // What the shell, or a program that execs this one, leads its report
    // of a program that cannot run with.
    const [lead, missing, voice] = missingProgram(name)
    const refusal = await cwdRefusal(name, cwd, errors)
    if (refusal !== null) return refusal
    let program: string
    if (name.includes('/')) {
      // A name with a slash is a path from the cwd, as in the shell.
      // Joined, not resolved, so the host follows a `..` past a symlink
      // as written.
      program = isAbsolute(name) ? name : `${rstripSlash(cwd)}/${name}`
      const refused = await unrunnable(program)
      if (refused !== null) return notRun(errors, `${lead}: ${refused[0]}\n`, refused[1])
    } else {
      program = await onHostPath(name)
      if (!(await isExecutable(program)))
        return notRun(errors, `${lead}: ${missing}\n`, NOT_FOUND_STATUS)
    }
    // A program that cannot start (its script's interpreter missing, say)
    // fails as the shell's would, so `tool || fallback` goes on.
    return this.spawnProgram(
      program,
      argv.slice(1),
      ctx.env ?? {},
      ctx.stdin,
      output,
      errors,
      ctx.signal,
      cwd,
    ).catch((err: unknown) => {
      const { code, syscall } = err as NodeJS.ErrnoException
      if (code === undefined || syscall?.startsWith('spawn') !== true) throw err
      // The shell says what failed; a program that execs this one says
      // only why.
      const reason = fsStrerror(err) ?? code
      const said = voice !== '' ? `cannot execute: ${reason}` : reason
      return notRun(errors, `${lead}: ${said}\n`, CANNOT_EXECUTE_STATUS)
    })
  }

  /** The interpreter the host PATH found, refused when it found none. */
  private async interpreter(): Promise<string> {
    const name = this.home ?? 'python3'
    const found = await this.python
    if (!(await isExecutable(found)))
      throw new Error(
        `local python interpreter not found: '${name}' (set the ` +
          `machine's \`home\` or ${LOCAL_HOME_ENV})`,
      )
    return found
  }

  private async spawnProgram(
    program: string,
    argv: string[],
    env: Record<string, string>,
    stdin: ByteSource | null,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<RunResult> {
    const given = { ...(this.config as LocalConfig).env, ...env }
    const clock = await systemTimeEnv(given)
    // A run still finding its program or libfaketime when the runtime
    // closed starts nothing, so no child outlives the close.
    if (this.closed) throw new Error(`${this.name}: the runtime is closed`)
    return runProgram(program, null, argv, stdin, {
      env: { ...given, ...clock },
      children: this.children,
      direct: true,
      output,
      errors,
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

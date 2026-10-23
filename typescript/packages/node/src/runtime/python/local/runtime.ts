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
import { accessSync, constants, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
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
import { closeChildren, cwdRefusal, runCli } from '../../sandbox/cli.ts'

const LOCAL_HOME_ENV = 'MIRAGE_LOCAL_HOME'

/**
 * Where the host's own PATH finds an interpreter, as Python's `shutil.which`
 * finds the twin's, as an absolute path: the program's environment carries
 * no host PATH, so the lookup cannot be left to spawn. An empty entry is the
 * current directory, as for the shell. A name with a slash is taken as
 * given, and one the PATH lacks too, so spawn reports it missing. On
 * Windows a name without one of `PATHEXT`'s suffixes is tried with each.
 */
function onHostPath(name: string): string {
  if (name.includes('/')) return name
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((s) => s !== '')
      : []
  const names =
    suffixes.length === 0 || suffixes.some((s) => name.toLowerCase().endsWith(s.toLowerCase()))
      ? [name]
      : suffixes.map((s) => name + s)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const each of names) {
      const candidate = resolve(dir, each)
      try {
        if (statSync(candidate, { throwIfNoEntry: false })?.isFile() !== true) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === undefined) throw err
        // Not usable here (not executable, an unreadable entry): the next
        // entry may be. Opt-in (NODE_DEBUG=mirage), on stderr.
        debuglog('mirage')('local: %s is not usable: %s', candidate, code)
      }
    }
  }
  return name
}

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
  private readonly python: string
  private readonly children = new Set<ChildProcess>()

  constructor(options: RuntimeOptions = {}) {
    super(options, LOCAL_CONFIG_KEYS)
    const chosen = resolveHome(this.config as LocalConfig, LOCAL_HOME_ENV)
    this.python = onHostPath(chosen ?? 'python3')
    if (chosen !== undefined) {
      try {
        accessSync(this.python, constants.X_OK)
      } catch (cause) {
        throw new Error(
          `local python interpreter not found: ${chosen} (from the runtime entry's config home or ${LOCAL_HOME_ENV})`,
          { cause },
        )
      }
    }
  }

  override version(_env: Record<string, string>, signal?: AbortSignal): Promise<RunResult> {
    // Session loader variables can execute code before --version is read.
    return this.spawnProgram(this.python, ['--version'], {}, null, signal)
  }

  interpret(_engine: undefined, program: Program, ctx: Context): Promise<RunResult> {
    // Honoring the init switches is just handing them back to the real
    // interpreter, which is why this tier gets them exactly right
    // (sys.flags included) where an in-process engine cannot.
    return this.spawnProgram(
      this.python,
      [...initArgv(ctx.flags), '-c', prepareSource(program, ctx.cwd), ...program.args],
      ctx.env ?? {},
      program.stdin,
      ctx.signal,
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
      program = onHostPath(name)
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

  private async spawnProgram(
    program: string,
    argv: string[],
    env: Record<string, string>,
    stdin: ByteSource | null,
    signal?: AbortSignal,
    cwd?: string,
    output?: (chunk: Uint8Array) => Promise<void>,
    errors?: (chunk: Uint8Array) => Promise<void>,
  ): Promise<RunResult> {
    const missing =
      program === this.python
        ? `local python interpreter not found: '${this.python}' (set the ` +
          `runtime entry's config home or ${LOCAL_HOME_ENV})`
        : null
    const { stdout, stderr, code } = await runCli(program, missing, argv, stdin, {
      env: { ...(this.config as LocalConfig).env, ...env },
      children: this.children,
      direct: true,
      ...(output === undefined ? {} : { output }),
      ...(errors === undefined ? {} : { errors }),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
    return { stdout, stderr: stderr.length > 0 ? stderr : null, exitCode: code }
  }

  override close(): Promise<void> {
    return closeChildren(this.children)
  }
}

registerRuntime('local', LocalRuntime)

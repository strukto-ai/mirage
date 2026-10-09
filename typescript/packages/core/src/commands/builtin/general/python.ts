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

import type { Accessor } from '../../../accessor/base.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { ExecutionNode } from '../../../workspace/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveScript } from '../utils/paths.ts'
import { FlagView } from '../../spec/flag_view.ts'
import {
  makeInterpreterHandler,
  moduleSource,
  runtimeVersion,
  skipFirstLine,
  PAYLOAD_ARGV0,
  STDIN_ARGV0,
  STDIN_OPERAND,
  type SourceMode,
} from './interpreter.ts'
import { PythonRuntime } from '../../../runtime/python/base.ts'
import type { InitFlags } from '../../../runtime/python/flags.ts'
import { MontyUnavailableError } from '../../../runtime/python/monty/index.ts'
import { PyodideUnavailableError } from '../../../runtime/python/pyodide/errors.ts'
import type { DispatchFn } from '../../../runtime/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface HandlePythonDeps {
  runtime: LanguageRuntime
}

const runPython = makeInterpreterHandler({
  label: 'python3',
  payloadFlag: '-c',
  isUnavailable: (err: unknown) =>
    err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError,
})

// `-m` against a runtime that cannot run modules. Exit 1 is CPython's code
// for a `-m` that could not run, but not its "No module named" wording:
// nothing was searched for, so naming the runtime is the honest report.
function moduleRefusal(
  mode: SourceMode | undefined,
  runtime: LanguageRuntime,
  label: string,
): string | null {
  if (mode !== 'module') return null
  if (!(runtime instanceof PythonRuntime) || runtime.runsModules) return null
  return `${label}: -m is not supported by the '${runtime.name}' runtime\n`
}

export async function handlePython(
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: {
    command?: string
    stdin: ByteSource | null
    env: Record<string, string>
    cwd?: PathSpec
    code: string | null
    // argv[0], derived from which entry point the source came through; '' is
    // CPython's own answer for a program piped in with no operand, so a
    // runtime must not treat it as absent.
    prog?: string
    mode?: SourceMode
    // CPython's -x. File mode only, which is CPython's own scope: -c,
    // -m and stdin are unaffected.
    skipFirstLine?: boolean
    initFlags?: InitFlags
    signal?: AbortSignal
    timeoutSeconds?: number
  },
  deps: HandlePythonDeps,
): Promise<Result> {
  return runPython(
    dispatch,
    pathScope,
    args,
    {
      command: opts.command ?? 'python3',
      stdin: opts.stdin,
      env: opts.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      code: opts.code,
      refuse: (runtime: LanguageRuntime) =>
        moduleRefusal(opts.mode, runtime, opts.command ?? 'python3'),
      ...(opts.prog !== undefined ? { prog: opts.prog } : {}),
      ...(opts.initFlags !== undefined ? { flags: opts.initFlags as Record<string, unknown> } : {}),
      ...(opts.skipFirstLine === true ? { transformSource: skipFirstLine } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    deps,
  )
}

// Keyed by CPython's own letter, which is how runtime/python/flags reads
// them; the one long switch is keyed by its canonical spelling, having
// no letter. -u and -q are absent because mirage buffers every stream
// and prints no banner, so no engine can differ on them, and -x is
// absent because it selects source rather than configuring an
// interpreter, so handlePython answers it.
function initFlags(fl: FlagView): InitFlags {
  return {
    b: fl.asInt('b') ?? 0,
    B: fl.asBool('B'),
    E: fl.asBool('E'),
    // -I and -O canonicalize to args_I/args_O (AMBIGUOUS_NAMES), so the
    // spec-checked FlagView refuses the bare letters.
    I: fl.asBool('args_I'),
    P: fl.asBool('P'),
    s: fl.asBool('s'),
    S: fl.asBool('S'),
    O: fl.asInt('args_O') ?? 0,
    W: fl.asList('W'),
    X: fl.asList('X'),
    check_hash_based_pycs: fl.asStr('check_hash_based_pycs') ?? null,
  }
}

async function pythonCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const label = opts.command ?? 'python3'
  if (!(opts.runtime instanceof LanguageRuntime)) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode(`${label}: command not found\n`),
      }),
    ]
  }

  const fl = new FlagView(opts.flags, specOf('python3'))
  if (fl.asBool('version')) {
    return runtimeVersion(label, opts.runtime, opts.env ?? {}, opts.signal, opts.timeoutSeconds)
  }

  if (opts.dispatch === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`${label}: no dispatch available\n`),
      }),
    ]
  }

  const code = fl.asStr('c') ?? null
  const moduleName = fl.asStr('m') ?? null
  const hasCode = code !== null
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  // Which entry point the source came through decides argv[0], so the two are
  // computed together. CPython spells it '-c' for a payload, the file as
  // typed for a script, '-' for the explicit stdin operand, and '' for
  // stdin with no operand at all; under -m runpy's alter_sys overwrites
  // it with the module's own file.
  let mode: SourceMode = 'payload'
  let argv0 = PAYLOAD_ARGV0
  if (moduleName !== null) {
    argStrs = [...paths.map((p) => p.virtual), ...texts]
    mode = 'module'
    argv0 = moduleName
  } else if (hasCode) {
    argStrs = [...paths.map((p) => p.virtual), ...texts]
  } else if (paths.length > 0) {
    scriptPath = paths[0] ?? null
    argStrs = [...paths.slice(1).map((p) => p.virtual), ...texts]
    mode = 'file'
    argv0 = paths[0]?.rawPath ?? ''
  } else if (texts[0] === STDIN_OPERAND) {
    // The explicit stdin spelling. It is an operand, not a flag, so the
    // words after it are the program's argv exactly as a script's would
    // be.
    argStrs = texts.slice(1)
    mode = 'stdin'
    argv0 = STDIN_ARGV0
  } else if (texts.length > 0) {
    scriptPath = resolveScript(texts[0] ?? '', opts.cwd)
    argStrs = texts.slice(1)
    mode = 'file'
    // As typed, which is what CPython puts in argv[0]; the resolved
    // spelling is scriptPath's job.
    argv0 = texts[0] ?? ''
  } else {
    argStrs = []
    mode = 'stdin'
    argv0 = ''
  }

  // The x check follows the source's entry point: a file operand asks the
  // per-path entry point about the script's own path, so a session whose only
  // x grant is one show subtree runs scripts there and nowhere else;
  // inline code, -m and stdin keep the whole-session rule, since no
  // path holds them. Outside a workspace no entry point is wired and
  // execAllowed answers for files too.
  if (mode === 'file' && scriptPath !== null) {
    const allowed = opts.execPathAllowed?.(scriptPath.virtual) ?? opts.execAllowed !== false
    if (!allowed) {
      const display = scriptPath.rawPath !== '' ? scriptPath.rawPath : scriptPath.virtual
      return [
        null,
        new IOResult({
          exitCode: 126,
          stderr: ENC.encode(`${label}: ${display}: not in EXEC mode\n`),
        }),
      ]
    }
  } else if (opts.execAllowed === false) {
    return [
      null,
      new IOResult({
        exitCode: 126,
        stderr: ENC.encode(`${label}: root mount '/' is not in EXEC mode\n`),
      }),
    ]
  }

  let resolvedCode: string | null = moduleName !== null ? moduleSource(moduleName, label) : code
  let stdinForRuntime = opts.stdin
  if (resolvedCode === null && scriptPath === null && opts.stdin !== null) {
    const bytes = await materialize(opts.stdin)
    if (bytes.length > 0) {
      resolvedCode = DEC.decode(bytes)
      stdinForRuntime = null
    }
  }

  const [stdout, io] = await handlePython(
    opts.dispatch,
    scriptPath,
    argStrs,
    {
      command: label,
      stdin: stdinForRuntime,
      env: opts.env ?? {},
      cwd: PathSpec.fromStrPath(opts.cwd),
      code: resolvedCode,
      prog: argv0,
      mode,
      skipFirstLine: fl.asBool('x'),
      initFlags: initFlags(fl),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    { runtime: opts.runtime },
  )
  return [stdout, io]
}

export const GENERAL_PYTHON3 = command({
  name: 'python3',
  vfs: null,
  spec: specOf('python3'),
  fn: pythonCommand,
})

export const GENERAL_PYTHON = command({
  name: 'python',
  vfs: null,
  spec: specOf('python'),
  fn: pythonCommand,
})

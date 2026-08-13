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
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { handlePython } from '../../../workspace/executor/python/handle.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveScript } from '../utils/operands.ts'
import { FlagView } from '../../spec/types.ts'
import {
  moduleSource,
  PAYLOAD_ARGV0,
  STDIN_ARGV0,
  STDIN_OPERAND,
  type SourceMode,
} from './interpreter.ts'
import type { InitFlags } from '../../../runtime/python/flags.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

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
  if (opts.execAllowed === false) {
    return [
      null,
      new IOResult({
        exitCode: 126,
        stderr: ENC.encode("python3: root mount '/' is not in EXEC mode\n"),
      }),
    ]
  }

  if (!(opts.runtime instanceof LanguageRuntime)) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode('python3: command not found\n'),
      }),
    ]
  }

  if (opts.dispatch === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('python3: no dispatch available\n'),
      }),
    ]
  }

  const fl = new FlagView(opts.flags, specOf('python3'))
  const code = fl.asStr('c') ?? null
  const moduleName = fl.asStr('m') ?? null
  const hasCode = code !== null
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  // Which door the source came through decides argv[0], so the two are
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

  let resolvedCode: string | null = moduleName !== null ? moduleSource(moduleName, 'python3') : code
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
      stdin: stdinForRuntime,
      env: opts.env ?? {},
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
  resource: null,
  spec: specOf('python3'),
  fn: pythonCommand,
})

export const GENERAL_PYTHON = command({
  name: 'python',
  resource: null,
  spec: specOf('python'),
  fn: pythonCommand,
})

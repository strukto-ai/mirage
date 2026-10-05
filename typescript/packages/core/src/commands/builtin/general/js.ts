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
import { QuickJsUnavailableError } from '../../../runtime/js/quickjs/errors.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import type { ExecutionNode } from '../../../workspace/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveScript } from '../utils/paths.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { makeInterpreterHandler, runtimeVersion, STDIN_OPERAND } from './interpreter.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface HandleJsDeps {
  runtime: LanguageRuntime
}

const runJs = makeInterpreterHandler({
  label: 'js',
  payloadFlag: '-e',
  isUnavailable: (err: unknown) => err instanceof QuickJsUnavailableError,
})

export async function handleJs(
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: {
    command?: string
    stdin: ByteSource | null
    env: Record<string, string>
    cwd?: PathSpec
    code: string | null
    module: boolean
    signal?: AbortSignal
    timeoutSeconds?: number
  },
  deps: HandleJsDeps,
): Promise<Result> {
  // A .mjs script is a module whatever the flag said (Python's js.py).
  const module = opts.module || (pathScope?.virtual.endsWith('.mjs') ?? false)
  return runJs(
    dispatch,
    pathScope,
    args,
    {
      command: opts.command ?? 'js',
      stdin: opts.stdin,
      env: opts.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      code: opts.code,
      flags: { module },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    deps,
  )
}

async function jsCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const label = opts.command ?? 'js'
  if (!(opts.runtime instanceof LanguageRuntime)) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode(`${label}: command not found\n`),
      }),
    ]
  }

  const fl = new FlagView(opts.flags, specOf('js'))
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

  const code = fl.asStr('e') ?? null
  const hasCode = code !== null
  const module = fl.asBool('module')
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  if (hasCode) {
    argStrs = [...paths.map((p) => p.virtual), ...texts]
  } else if (paths.length > 0) {
    scriptPath = paths[0] ?? null
    argStrs = [...paths.slice(1).map((p) => p.virtual), ...texts]
  } else if (texts[0] === STDIN_OPERAND) {
    // The explicit stdin spelling, the same operand python3 honors: it is
    // an operand, not a flag, so the words after it are the program's argv
    // exactly as a script's would be. Leaving scriptPath null routes the
    // source to the stdin read below, which is what `node -` does.
    argStrs = texts.slice(1)
  } else if (texts.length > 0) {
    scriptPath = resolveScript(texts[0] ?? '', opts.cwd)
    argStrs = texts.slice(1)
  } else {
    argStrs = []
  }

  // The x check follows the source's door, exactly as python3's: a
  // file operand asks the per-path door, everything else keeps the
  // whole-session rule.
  if (scriptPath !== null) {
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

  let resolvedCode: string | null = code
  let stdinForRuntime = opts.stdin
  if (resolvedCode === null && scriptPath === null && opts.stdin !== null) {
    const bytes = await materialize(opts.stdin)
    if (bytes.length > 0) {
      resolvedCode = DEC.decode(bytes)
      stdinForRuntime = null
    }
  }

  const [stdout, io] = await handleJs(
    opts.dispatch,
    scriptPath,
    argStrs,
    {
      command: label,
      stdin: stdinForRuntime,
      env: opts.env ?? {},
      cwd: PathSpec.fromStrPath(opts.cwd),
      code: resolvedCode,
      module,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    { runtime: opts.runtime },
  )
  return [stdout, io]
}

export const GENERAL_JS = command({
  name: 'js',
  vfs: null,
  spec: specOf('js'),
  fn: jsCommand,
})

export const GENERAL_NODE = command({
  name: 'node',
  vfs: null,
  spec: specOf('node'),
  fn: jsCommand,
})

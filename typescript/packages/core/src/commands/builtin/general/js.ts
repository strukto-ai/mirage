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
import { handleJs } from '../../../workspace/executor/js/handle.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveScript } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

async function jsCommand(
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
        stderr: ENC.encode("js: root mount '/' is not in EXEC mode\n"),
      }),
    ]
  }

  if (opts.jsRuntime === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode('js: javascript runtime is not available\n'),
      }),
    ]
  }

  if (opts.dispatch === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('js: no dispatch available\n'),
      }),
    ]
  }

  const eFlag = opts.flags.e
  const code = typeof eFlag === 'string' ? eFlag : null
  const hasCode = code !== null
  const module = opts.flags.m === true || opts.flags.module === true
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  if (hasCode) {
    argStrs = [...paths.map((p) => p.virtual), ...texts]
  } else if (paths.length > 0) {
    scriptPath = paths[0] ?? null
    argStrs = [...paths.slice(1).map((p) => p.virtual), ...texts]
  } else if (texts.length > 0) {
    scriptPath = resolveScript(texts[0] ?? '', opts.cwd)
    argStrs = texts.slice(1)
  } else {
    argStrs = []
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
      stdin: stdinForRuntime,
      env: opts.env ?? {},
      code: resolvedCode,
      module,
    },
    { runtime: opts.jsRuntime },
  )
  return [stdout, io]
}

export const GENERAL_JS = command({
  name: 'js',
  resource: null,
  spec: specOf('js'),
  fn: jsCommand,
})

export const GENERAL_NODE = command({
  name: 'node',
  resource: null,
  spec: specOf('node'),
  fn: jsCommand,
})

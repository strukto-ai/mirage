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
import { PathSpec } from '../../../types.ts'
import { handlePython } from '../../../workspace/executor/python/handle.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function normalizePosix(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

function resolveScript(name: string, cwd: string): PathSpec {
  const joined = name.startsWith('/') ? name : `${cwd.replace(/\/+$/, '')}/${name}`
  const path = normalizePosix(joined)
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ original: path, directory, resolved: true })
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

  if (opts.pythonRuntime === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode('python3: python runtime is not available\n'),
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

  const cFlag = opts.flags.c
  const code = typeof cFlag === 'string' ? cFlag : null
  const hasCode = code !== null
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  if (hasCode) {
    argStrs = [...paths.map((p) => p.original), ...texts]
  } else if (paths.length > 0) {
    scriptPath = paths[0] ?? null
    argStrs = [...paths.slice(1).map((p) => p.original), ...texts]
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

  const [stdout, io] = await handlePython(
    opts.dispatch,
    scriptPath,
    argStrs,
    {
      stdin: stdinForRuntime,
      env: opts.env ?? {},
      code: resolvedCode,
    },
    { runtime: opts.pythonRuntime },
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

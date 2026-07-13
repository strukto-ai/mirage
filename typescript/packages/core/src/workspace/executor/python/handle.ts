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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { ByteSource } from '../../../io/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { ExecutionNode } from '../../types.ts'
import type { PythonRuntime } from './runtimes/interface.ts'
import { MontyUnavailableError } from './runtimes/monty.ts'
import { PyodideUnavailableError, type PythonReplRunResult } from './types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface HandlePythonDeps {
  runtime: PythonRuntime
}

function readAllBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return Promise.resolve(data)
  if (data === null || data === undefined) return Promise.resolve(new Uint8Array())
  return materialize(data as ByteSource)
}

function toPathSpec(p: PathSpec): PathSpec {
  return new PathSpec({
    virtual: p.virtual,
    directory: p.directory,
    pattern: p.pattern,
    resolved: p.resolved,
    resourcePath: mountKey(p.virtual, mountPrefixOf(p.virtual, p.resourcePath)),
  })
}

export async function handlePython(
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: {
    stdin: ByteSource | null
    env: Record<string, string>
    code: string | null
  },
  deps: HandlePythonDeps,
): Promise<Result> {
  let code = opts.code
  const cmdStr = pathScope !== null ? `python3 ${pathScope.virtual}` : 'python3 -c'

  if (code === null) {
    if (pathScope === null) {
      const err = new TextEncoder().encode('python3: no input\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1 }),
      ]
    }
    try {
      const [data] = await dispatch('read', toPathSpec(pathScope))
      const bytes = await readAllBytes(data)
      code = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch {
      const err = new TextEncoder().encode(`python3: ${pathScope.virtual}: No such file\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1 }),
      ]
    }
  }

  let stdinBytes: Uint8Array | null = null
  if (opts.stdin !== null) {
    stdinBytes = await materialize(opts.stdin)
  }

  try {
    const result = await deps.runtime.run({
      code,
      args,
      env: opts.env,
      stdin: stdinBytes,
    })
    return [
      result.stdout.length > 0 ? result.stdout : null,
      new IOResult({ exitCode: result.exitCode, stderr: result.stderr }),
      new ExecutionNode({ command: cmdStr, exitCode: result.exitCode }),
    ]
  } catch (err) {
    if (err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError) {
      return [
        null,
        new IOResult({
          exitCode: 127,
          stderr: new TextEncoder().encode(`python3: ${err.message}\n`),
        }),
        new ExecutionNode({ command: cmdStr, exitCode: 127 }),
      ]
    }
    const msg = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(`python3: ${msg}\n`),
      }),
      new ExecutionNode({ command: cmdStr, exitCode: 1 }),
    ]
  }
}

export async function handlePythonRepl(
  code: string,
  sessionId: string,
  deps: HandlePythonDeps,
): Promise<PythonReplRunResult> {
  try {
    return await deps.runtime.runRepl({ code, sessionId })
  } catch (err) {
    if (err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError) {
      return {
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(`python3: ${err.message}\n`),
        exitCode: 127,
        status: 'complete',
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return {
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(`python3: ${msg}\n`),
      exitCode: 1,
      status: 'complete',
    }
  }
}

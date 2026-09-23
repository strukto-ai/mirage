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

import { runOutput } from '../../commands/builtin/general/interpreter.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { LanguageRuntime } from '../../runtime/language.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { PathSpec } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { ExecutionNode } from '../types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const ENC = new TextEncoder()

interface InterpreterDeps {
  runtime: LanguageRuntime
}

interface InterpreterOpts {
  command?: string
  stdin: ByteSource | null
  env: Record<string, string>
  cwd?: PathSpec
  code: string | null
  // argv[0], derived from which door the source came through; '' is
  // CPython's own answer for a program piped in with no operand, so a
  // runtime must not treat it as absent.
  prog?: string
  // Runtime-specific run flags (Python's InitFlags, js's `module`).
  flags?: Record<string, unknown>
  // Applied to a script read from a file (CPython's -x).
  transformSource?: (code: string) => string
  // A refusal decided once the runtime is bound (Python's -m guard):
  // the diagnostic text, or null to proceed.
  refuse?: (runtime: LanguageRuntime) => string | null
  signal?: AbortSignal
  timeoutSeconds?: number
}

// The language-specific half of an interpreter handler: everything else
// (reading the script, materializing stdin, running, mapping errors) is
// identical between python3 and js, mirroring Python's single run_code.
export interface InterpreterSpec {
  // Command name used in every diagnostic.
  label: string
  // Payload flag shown when no script operand was given (-c, -e).
  payloadFlag: string
  // Whether a thrown error means the runtime itself is missing (exit 127).
  isUnavailable: (err: unknown) => boolean
}

export type InterpreterHandler = (
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: InterpreterOpts,
  deps: InterpreterDeps,
) => Promise<Result>

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
    vfsPath: mountKey(p.virtual, mountPrefixOf(p.virtual, p.vfsPath)),
  })
}

// An interpreter diagnostic. The stderr rides the IOResult only: the node
// carries the command string and the code, matching what the shell prints.
function errorResult(cmdStr: string, message: string, exitCode: number): Result {
  return [
    null,
    new IOResult({ exitCode, stderr: ENC.encode(message) }),
    new ExecutionNode({ command: cmdStr, exitCode }),
  ]
}

/**
 * Build an interpreter command handler.
 *
 * @param spec - the label, payload flag and unavailable-error test that
 *   distinguish one interpreter from another.
 */
export function makeInterpreterHandler(spec: InterpreterSpec): InterpreterHandler {
  return async function handle(
    dispatch: DispatchFn,
    pathScope: PathSpec | null,
    args: string[],
    opts: InterpreterOpts,
    deps: InterpreterDeps,
  ): Promise<Result> {
    const label = opts.command ?? spec.label
    let code = opts.code
    const cmdStr =
      pathScope !== null ? `${label} ${pathScope.virtual}` : `${label} ${spec.payloadFlag}`

    if (code === null) {
      if (pathScope === null) return errorResult(cmdStr, `${label}: no input\n`, 1)
      try {
        const [data] = await dispatch('read', toPathSpec(pathScope))
        const bytes = await readAllBytes(data)
        code = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        if (opts.transformSource !== undefined) code = opts.transformSource(code)
      } catch {
        return errorResult(cmdStr, `${label}: ${pathScope.virtual}: No such file\n`, 1)
      }
    }

    let stdinBytes: Uint8Array | null = null
    if (opts.stdin !== null) {
      stdinBytes = await materialize(opts.stdin)
    }

    try {
      const refusal = opts.refuse?.(deps.runtime) ?? null
      if (refusal !== null) return errorResult(cmdStr, refusal, 1)
      const result = await deps.runtime.execute({
        kind: 'code',
        language: deps.runtime.language,
        code,
        args,
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        stdin: stdinBytes,
        ...(opts.prog !== undefined ? { prog: opts.prog } : {}),
        ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      })
      const [stdout, io] = runOutput(result)
      return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: result.exitCode })]
    } catch (err) {
      // An in-VM limit interrupt is a timeout, not an interpreter
      // failure: let it reach the workspace's 124 handler.
      if (err instanceof CommandTimeoutError) throw err
      if (spec.isUnavailable(err)) {
        return errorResult(cmdStr, `${label}: ${(err as Error).message}\n`, 127)
      }
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(cmdStr, `${label}: ${msg}\n`, 1)
    }
  }
}

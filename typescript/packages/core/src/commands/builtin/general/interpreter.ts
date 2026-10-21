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

import { IOResult } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import { QuickJsUnavailableError } from '../../../runtime/js/quickjs/errors.ts'
import { MontyUnavailableError } from '../../../runtime/python/monty/errors.ts'
import { PyodideUnavailableError } from '../../../runtime/python/pyodide/errors.ts'
import type { CommandRuntime, RunResult } from '../../../runtime/types.ts'
import type { PathSpec, Producer } from '../../../types.ts'
import { errorVirtualPath, isFsError } from '../../../errors/fs.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import type { CommandFnResult, Context } from '../../config.ts'

/**
 * Convert one runtime outcome into a command's output pair.
 *
 * The single RunResult-to-IOResult mapping: empty stdout becomes null
 * (no stream), the exit code and stderr pass through. The interpreter
 * handlers, the CLI script arm and a captured program all convert through
 * here so the mapping cannot drift (Python's run_output in
 * commands/builtin/general/interpreter.py).
 *
 * @param result the runtime's outcome.
 * @param producer what made the output, for a program run past the
 *   workspace's own commands.
 */
export function runOutput(
  result: RunResult,
  producer: Producer | null = null,
): [Uint8Array | null, IOResult] {
  return [
    result.stdout.length > 0 ? result.stdout : null,
    new IOResult({ exitCode: result.exitCode, stderr: result.stderr, producer }),
  ]
}

/**
 * Whether a thrown error means the runtime itself is missing (exit 127),
 * not that the program it ran failed.
 *
 * Args:
 *   err: the error the runtime threw.
 */
export function runtimeUnavailable(err: unknown): err is Error {
  return (
    err instanceof QuickJsUnavailableError ||
    err instanceof MontyUnavailableError ||
    err instanceof PyodideUnavailableError
  )
}

export async function runtimeVersion(
  label: string,
  runtime: LanguageRuntime,
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutSeconds?: number,
): Promise<[Uint8Array | null, IOResult]> {
  try {
    return runOutput(await runtime.version(env, signal, timeoutSeconds))
  } catch (err) {
    if (err instanceof CommandTimeoutError) throw err
    const message = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: runtimeUnavailable(err) ? 127 : 1,
        stderr: new TextEncoder().encode(`${label}: ${message}\n`),
      }),
    ]
  }
}

function failed(label: string, message: string, exitCode: number): [null, IOResult] {
  return [
    null,
    new IOResult({ exitCode, stderr: new TextEncoder().encode(`${label}: ${message}\n`) }),
  ]
}

/**
 * The answer of an interpreter command no runtime runs: bash's
 * `command not found`, exit 127, whatever the operands say.
 */
export function notBound(label: string): CommandFnResult {
  return failed(label, 'command not found', 127)
}

/**
 * Why policy will not let an interpreter command run its program; null
 * when it may.
 *
 * The x check follows the program's entry point. A script operand asks
 * the per-path entry point about the script's own path, so a session
 * whose only x grant is one show subtree runs scripts there and nowhere
 * else; inline code (-c/-e), -m and stdin keep the whole-session rule
 * (`execAllowed`: any x grant), since no path holds them. Outside a
 * workspace no per-path entry point is wired and `execAllowed` answers
 * for files too. Mirrors Python's `exec_refusal`.
 *
 * @param label the command name used in the message.
 * @param script the script operand, null for a program from -c, -m or
 *   stdin (`scriptOperand`).
 * @param placement the command's exec policy; absent allows.
 */
export function execRefusal(
  label: string,
  script: PathSpec | null,
  placement: CommandRuntime | undefined,
): [null, IOResult] | null {
  if (script !== null) {
    const allowed = placement?.execPathAllowed?.(script.virtual) ?? placement?.execAllowed !== false
    if (allowed) return null
    const display = script.rawPath !== '' ? script.rawPath : script.virtual
    return failed(label, `${display}: not in EXEC mode`, 126)
  }
  if (placement?.execAllowed !== false) return null
  return failed(label, "root mount '/' is not in EXEC mode", 126)
}

/**
 * Run an interpreter command's operands on its bound runtime and convert
 * the outcome. A failure of the runtime itself answers as the command: a
 * missing engine 127, any other 1, an in-VM limit interrupt a timeout
 * named after the command, as the workspace's own timer names it. A
 * script the runtime could not read is the command's own read failure,
 * left to the executor to render as any command's is, as Python lets it
 * escape.
 *
 * @param label the command name used in messages.
 * @param runtime the runtime bound to the command.
 * @param paths the path operands.
 * @param texts the text operands.
 * @param ctx the command's context, its flags the runtime's switches.
 * @param script the script operand (`scriptOperand`), null for a program
 *   from -c, -m or stdin.
 */
export async function runInterpreter(
  label: string,
  runtime: LanguageRuntime,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  script: PathSpec | null,
): Promise<CommandFnResult> {
  try {
    return runOutput(await runtime.execute(paths, texts, ctx))
  } catch (err) {
    if (err instanceof CommandTimeoutError) throw new CommandTimeoutError(label, err.seconds)
    if (script !== null && isFsError(err) && errorVirtualPath(err) === script.virtual) throw err
    const message = err instanceof Error ? err.message : String(err)
    return failed(label, message, runtimeUnavailable(err) ? 127 : 1)
  }
}

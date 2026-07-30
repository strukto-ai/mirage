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

import { EvalError, type EvalValue } from './runtime.ts'

/**
 * The result envelope: a remote evaluator only speaks the process
 * dialect (stdout/stderr/exit), so the value comes home as JSON behind
 * this sentinel, appended as the program's final stdout write. NUL
 * bytes cannot appear in JSON text, so user output never forges it.
 */
export const SENTINEL = '\x00MIRAGE_EVAL\x00'

// The far-side harness: binds the inputs as globals, runs the user
// code, captures its LAST EXPRESSION (monty semantics), and emits the
// envelope. User prints stream to stdout ahead of the sentinel; any
// raised exception exits nonzero with its own traceback and no
// envelope.
const HARNESS = `\
import ast as _ast
import json as _json
import sys as _sys
_code = _json.loads({code_json})
_tree = _ast.parse(_code)
_last = None
if _tree.body and isinstance(_tree.body[-1], _ast.Expr):
    _last = _ast.Expression(_tree.body[-1].value)
    _tree.body = _tree.body[:-1]
_globals = _json.loads({inputs_json})
exec(compile(_tree, "<eval>", "exec"), _globals)
_value = None
if _last is not None:
    _value = eval(compile(_last, "<eval>", "eval"), _globals)
try:
    _payload = _json.dumps(_value)
except TypeError:
    _sys.stderr.write(
        "eval: result of type %s is not JSON-serializable\\n"
        % type(_value).__name__)
    _sys.exit(1)
_sys.stdout.write({sentinel_json} + _payload)
`

/**
 * Wrap user code in the far-side envelope harness. The harness needs
 * only a stock python3 on the remote side; code and inputs travel
 * embedded as JSON literals, so no argument quoting is involved.
 * Throws EvalError when the inputs exceed what JSON can carry.
 */
export function pythonEvalHarness(
  code: string,
  inputs: Record<string, EvalValue> | undefined,
): string {
  let inputsJson: string
  try {
    inputsJson = JSON.stringify(inputs ?? {})
  } catch (caught) {
    throw new EvalError(`eval inputs are not JSON-serializable: ${String(caught)}`, {
      cause: caught,
    })
  }
  if (inputsJson === undefined) {
    throw new EvalError('eval inputs are not JSON-serializable')
  }
  return HARNESS.replace('{code_json}', JSON.stringify(JSON.stringify(code)))
    .replace('{inputs_json}', JSON.stringify(inputsJson))
    .replace('{sentinel_json}', JSON.stringify(SENTINEL))
}

/**
 * Split a remote run's stdout into user output and the value. Throws
 * EvalError when no envelope is present (the program exited before its
 * final expression) or the payload is not valid JSON.
 */
export function splitEnvelope(stdout: Uint8Array): [Uint8Array, EvalValue] {
  const sentinel = new TextEncoder().encode(SENTINEL)
  const at = lastIndexOfBytes(stdout, sentinel)
  if (at < 0) {
    throw new EvalError(
      'evaluation produced no result envelope ' +
        '(the program exited before its final expression)',
    )
  }
  const head = stdout.slice(0, at)
  const tail = stdout.slice(at + sentinel.length)
  try {
    return [head, JSON.parse(new TextDecoder().decode(tail)) as EvalValue]
  } catch (caught) {
    throw new EvalError(`eval result envelope is not valid JSON: ${String(caught)}`, {
      cause: caught,
    })
  }
}

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = haystack.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

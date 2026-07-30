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

// How to give YOUR OWN runtime the evaluator capability: implement the
// Evaluator interface's eval (inputs in, the last expression's value
// out). The transport is yours to choose; mirage only defines the
// contract. Here a docker container evaluates python by piping a
// harness to its stock `python3 -`: the value comes back as JSON
// behind a NUL sentinel on stdout (NUL cannot appear in JSON text, so
// user prints cannot forge it). An evaluator runtime can also serve as
// the workspace's routing policy engine. Start the container first:
//
//     docker run -d --name mirage-eval-demo python:3.12-slim sleep infinity
//
// and remove it when done: docker rm -f mirage-eval-demo

import {
  DockerRuntime,
  EvalError,
  type EvalResult,
  type Evaluator,
  type EvalValue,
} from '@struktoai/mirage-node'

const CONTAINER = 'mirage-eval-demo'

const SENTINEL = '\x00MIRAGE_EVAL\x00'

// Runs inside the container: bind inputs as globals, execute the user
// code, evaluate its trailing expression, emit the value as JSON
// behind the sentinel. User prints stream to stdout ahead of it; a
// raised exception exits nonzero with its own traceback instead.
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
_sys.stdout.write({sentinel_json} + _json.dumps(_value))
`

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = haystack.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

class EvalDockerRuntime extends DockerRuntime implements Evaluator {
  async eval(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string } = {},
  ): Promise<EvalResult> {
    if (opts.session !== undefined) {
      throw new EvalError('one exec per run; sessions are not supported')
    }
    const harness = HARNESS.replace('{code_json}', JSON.stringify(JSON.stringify(code)))
      .replace('{inputs_json}', JSON.stringify(JSON.stringify(opts.inputs ?? {})))
      .replace('{sentinel_json}', JSON.stringify(SENTINEL))
    const result = await this.runLine('python3 -', new TextEncoder().encode(harness), {}, '/')
    if (result.exitCode !== 0) {
      const detail = result.stderr !== null ? new TextDecoder().decode(result.stderr).trim() : ''
      throw new EvalError(detail !== '' ? detail : `evaluation exited ${String(result.exitCode)}`)
    }
    const sentinel = new TextEncoder().encode(SENTINEL)
    const at = lastIndexOfBytes(result.stdout, sentinel)
    if (at < 0) throw new EvalError('the program exited before its final expression')
    const tail = new TextDecoder().decode(result.stdout.slice(at + sentinel.length))
    return {
      value: JSON.parse(tail) as EvalValue,
      stdout: result.stdout.slice(0, at),
      stderr: result.stderr,
      exitCode: 0,
      status: 'complete',
    }
  }
}

async function main(): Promise<void> {
  const runtime = new EvalDockerRuntime({ config: { container: CONTAINER } })

  const result = await runtime.eval(
    "print('computing inside the container')\n" + "sum(ctx['xs']) * ctx['factor']",
    { inputs: { ctx: { xs: [1, 2, 3], factor: 7 } } },
  )
  console.log(`value: ${JSON.stringify(result.value)}`)
  console.log(`container stdout: ${JSON.stringify(new TextDecoder().decode(result.stdout))}`)

  try {
    await runtime.eval('1 / 0')
  } catch (err) {
    if (!(err instanceof EvalError)) throw err
    const lastLine = err.message.trim().split('\n').at(-1)
    console.log(`remote failure surfaces as EvalError: ${lastLine}`)
  }

  await runtime.close()
}

await main()

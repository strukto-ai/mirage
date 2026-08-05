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

import * as jqWasm from 'jq-wasm'
import { ARGS_VAR, INPUTS_VAR, type JqOptions } from './types.ts'

const INPUTS_REF = /\binputs\b/
const ARGS_REF = /\$ARGS\b/
const TO_STREAM = 'tostream'

/**
 * Report whether a jq program mentions the `inputs` builtin.
 *
 * Binding the remaining documents is what makes `inputs` work, and that
 * binding is one copy of the stream per evaluation, so it is only paid
 * for by a program that asks for it. A mention inside a string literal
 * reads as a reference, which costs a binding and changes nothing else.
 */
export function referencesInputs(expr: string): boolean {
  return INPUTS_REF.test(expr)
}

/** Report whether a jq program mentions the `$ARGS` variable. */
export function referencesArgs(expr: string): boolean {
  return ARGS_REF.test(expr)
}

/** The value `$ARGS` resolves to for a run. */
export function argsObject(opts: JqOptions): Record<string, unknown> {
  return { positional: [...opts.positionalArgs], named: { ...opts.namedArgs } }
}

/**
 * The `[path, leaf]` events `--stream` reads a document as.
 *
 * jq's own `tostream` emits exactly the events `--stream` produces for a
 * complete document; the two differ only for input too truncated to
 * parse, which never reaches here because mirage reads whole values.
 */
export function streamEvents(doc: unknown): Promise<unknown[]> {
  return jqEval(doc, TO_STREAM)
}

/**
 * Evaluate a jq expression against obj.
 *
 * A jq program is a stream transformer: it emits zero, one or many values,
 * and jq prints each on its own line. That arity is preserved here rather
 * than collapsed, so two outputs are never confused with one output that
 * happens to be an array. `.a, .b` yields two values; `[.a, .b]` yields one.
 *
 * Returns every output value, in order. Empty when the program produces no
 * output at all, which real jq reports as exit 0 with empty stdout.
 *
 * `namedArgs` are the $name bindings from --arg / --argjson. `inputs` are
 * the documents the `inputs` builtin should yield, i.e. the ones still
 * unread at this point in the stream: this evaluator is handed one value
 * at a time and owns no input stream, so `inputs` is bound as a
 * definition over a named argument instead. A user program that defines
 * its own `inputs` shadows it, as it would shadow the builtin.
 */
export async function jqEval(
  obj: unknown,
  expr: string,
  namedArgs: Readonly<Record<string, unknown>> = {},
  inputs: readonly unknown[] | null = null,
  argsValue: Readonly<Record<string, unknown>> | null = null,
): Promise<unknown[]> {
  const args = ['-c']
  for (const [name, value] of Object.entries(namedArgs)) {
    args.push('--argjson', name, JSON.stringify(value))
  }
  // A prelude shifts every line and column a syntax error reports, so
  // neither is added unless the program asked for what it binds.
  let prelude = ''
  let body = expr
  if (inputs !== null) {
    args.push('--argjson', INPUTS_VAR, JSON.stringify(inputs))
    prelude = `def inputs: $${INPUTS_VAR}[];\n`
  }
  if (argsValue !== null) {
    // jq defines $ARGS itself, from the --arg flags this evaluator
    // passes, so the only way to serve mirage's own is to rebind it.
    args.push('--argjson', ARGS_VAR, JSON.stringify(argsValue))
    prelude = `${prelude}$${ARGS_VAR} as $ARGS |\n`
    body = `(${expr})`
  }
  const program = prelude === '' ? expr : prelude + body
  const result = await jqWasm.raw(JSON.stringify(obj), program, args)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `jq exited with code ${String(result.exitCode)}`)
  }
  if (result.stdout === '') return []
  const lines = result.stdout.split('\n').filter((l) => l !== '')
  return lines.map((l) => JSON.parse(l) as unknown)
}

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
import { JQ_EMPTY } from './format.ts'

/**
 * Report whether a jq program spreads its input at the top level.
 *
 * A top-level `[]` means the program emits one output per element, so the
 * caller must print each on its own line. A `[]` nested inside a collector
 * (`[.a[] | .b]`) does not: that program emits a single array. Strings are
 * skipped so a literal "[]" never counts.
 */
export function hasTopLevelSpread(expr: string): boolean {
  let depth = 0
  let inStr = false
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === '"' && (i === 0 || expr[i - 1] !== '\\')) {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (depth === 0 && ch === '[' && expr[i + 1] === ']') return true
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
  }
  return false
}

export async function jqEval(obj: unknown, expr: string): Promise<unknown> {
  const result = await jqWasm.raw(JSON.stringify(obj), expr, ['-c'])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `jq exited with code ${String(result.exitCode)}`)
  }
  const lines = result.stdout === '' ? [] : result.stdout.split('\n').filter((l) => l !== '')
  const outputs = lines.map((l) => JSON.parse(l) as unknown)
  if (outputs.length === 0) return JQ_EMPTY
  if (outputs.length === 1 && !hasTopLevelSpread(expr)) return outputs[0]
  return outputs
}

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

import { stringText } from './parse.ts'
import type { JqOptions, StreamReads } from './types.ts'

const INPUT_REF = /(?<![\w$.:])input(?![\w:])/
const INPUTS_REF = /(?<![\w$.:])inputs(?![\w:])/
const INPUT_DEF = /(?<![\w$.:])def\s+input\s*[:(]/
const INPUTS_DEF = /(?<![\w$.:])def\s+inputs\s*[:(]/
const ARGS_REF = /\$ARGS(?![\w:])/
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y
const INTERP = '\\('
const OPENERS = '([{'
const CLOSERS = ')]}'

/**
 * Blank out every part of a jq program that cannot be a call.
 *
 * Three things are replaced by spaces: string bodies, `#` comments, and the
 * field names an object shorthand abbreviates (`{a, inputs}` is
 * `{a: .a, inputs: .inputs}`). Interpolations stay code, because
 * `"\(inputs)"` really does call the builtin, so everything between `\(`
 * and its closing paren survives, nested strings included.
 */
function codeOnly(expr: string): string {
  const out: string[] = []
  // Open brackets, innermost last, with an interpolation recorded as one
  // too; empty means the scan is at the top level of the program.
  const stack: string[] = []
  let inString = false
  let prev = ''
  let i = 0
  while (i < expr.length) {
    const ch = expr.charAt(i)
    if (inString) {
      if (ch === '\\' && i + 1 < expr.length) {
        if (expr.charAt(i + 1) === '(') {
          inString = false
          stack.push(INTERP)
        }
        out.push('  ')
        i += 2
        continue
      }
      inString = ch !== '"'
      out.push(' ')
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out.push(' ')
      i += 1
      continue
    }
    if (ch === '#') {
      while (i < expr.length && expr.charAt(i) !== '\n') {
        out.push(' ')
        i += 1
      }
      continue
    }
    IDENT.lastIndex = i
    const word = IDENT.exec(expr)
    if (word !== null) {
      const text = word[0]
      const key = stack[stack.length - 1] === '{' && (prev === '{' || prev === ',')
      out.push(key ? ' '.repeat(text.length) : text)
      prev = text.charAt(text.length - 1)
      i += text.length
      continue
    }
    if (OPENERS.includes(ch)) {
      stack.push(ch)
    } else if (ch === ')' && stack[stack.length - 1] === INTERP) {
      stack.pop()
      inString = true
      out.push(' ')
      prev = ''
      i += 1
      continue
    } else if (CLOSERS.includes(ch) && stack.length > 0 && stack[stack.length - 1] !== INTERP) {
      stack.pop()
    }
    out.push(ch)
    if (ch.trim() !== '') prev = ch
    i += 1
  }
  return out.join('')
}

/**
 * Report which of the builtins that read the input stream a program calls.
 *
 * Binding the unread documents is what makes `input` and `inputs` work,
 * and it also changes how many documents a run consumes, so only the
 * builtins may answer here: the words also spell a field (`.inputs`,
 * `{inputs}`), a variable (`$inputs`), an object key (`{inputs: 1}`), a
 * module member (`m::inputs`), a function the program defines for itself
 * (`def input: ...`), and anything at all inside a string or a comment,
 * none of which read the stream.
 */
export function streamReads(expr: string): StreamReads {
  const code = codeOnly(expr)
  return {
    input: INPUT_REF.test(code) && !INPUT_DEF.test(code),
    inputs: INPUTS_REF.test(code) && !INPUTS_DEF.test(code),
  }
}

/** Report whether a jq program reads the `$ARGS` variable. */
export function referencesArgs(expr: string): boolean {
  return ARGS_REF.test(codeOnly(expr))
}

/** The JSON text of the value `$ARGS` resolves to for a run. */
export function argsText(opts: JqOptions): string {
  const named = [...opts.namedArgs].map(([name, text]) => `${stringText(name)}:${text}`)
  return `{"positional":[${opts.positionalArgs.join(',')}],"named":{${named.join(',')}}}`
}

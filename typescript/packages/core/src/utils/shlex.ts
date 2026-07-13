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

// Mirror of Python's shlex.split: POSIX shell word splitting with
// single-quote, double-quote, and backslash escape handling.
export function shlexSplit(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === undefined) break
    if (inSingle) {
      if (c === "'") {
        inSingle = false
      } else {
        cur += c
      }
      i++
      continue
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false
      } else if (c === '\\' && i + 1 < input.length) {
        const next = input[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next
          i += 2
          continue
        }
        cur += c
      } else {
        cur += c
      }
      i++
      continue
    }
    if (c === "'") {
      inSingle = true
    } else if (c === '"') {
      inDouble = true
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[i + 1] ?? ''
      i += 2
      continue
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += c
    }
    i++
  }
  if (inSingle || inDouble) {
    throw new Error(`unterminated quote in: ${input}`)
  }
  if (cur !== '') out.push(cur)
  return out
}

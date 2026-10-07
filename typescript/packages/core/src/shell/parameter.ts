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

import { PARAMETER_NAME } from './constants.ts'

/**
 * Recognize a plain dollar reference, returning its name and end.
 *
 * Names use Bash's ASCII identifier grammar. Unbraced positionals
 * consume one digit; braces permit multiple digits. Special parameters
 * consume one character. The caller owns quoting and must only scan a
 * live dollar. Complex braced operators remain the expansion parser's
 * responsibility and return null here, as do non-reference dollars.
 * `start` and the returned end are offsets into `text`.
 */
export function scanParameter(text: string, start: number): [string, number] | null {
  if (text[start] !== '$') return null
  let begin = start + 1
  const braced = text[begin] === '{'
  if (braced) begin += 1
  const match = PARAMETER_NAME.exec(text.slice(begin))
  if (match === null) return null
  let name = match[0]
  if (!braced && /^[0-9]/.test(name)) name = name.slice(0, 1)
  let end = begin + name.length
  if (braced) {
    if (text[end] !== '}') return null
    end += 1
  }
  return [name, end]
}

// What bash reads a braced name against when it expands `${...}`: what ends
// a name, what ends one after a special parameter, the specials a `#`
// measures and a `!` follows, the special parameters themselves, the
// operators a `:` arms, and what may follow a name.
const NAME_ENDS = '#%^,~:-=?+/@}'
const SPECIAL_ENDS = '#%:-=?+/@}'
const LENGTH_SPECIALS = '-?#@'
const INDIRECT_SPECIALS = '#?@*'
const SPECIALS = '@*#?-$!'
const NULL_OPERATORS = '-=?+'
const OPERATORS = '}@#%-=?+/^,~'
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DIGITS = /^[0-9]+$/

/**
 * Whether bash refuses a `${...}` for its spelling alone.
 *
 * bash reads the braces only when the word holding them expands, and then
 * reports `bad substitution` for a name that is no identifier, positional or
 * special parameter (`${a b}`, `${ a}`, `${}`), an element reference that is
 * not one whole (`${a[1]x}`), a `#` measuring more than a name (`${#a-x}`),
 * or a name followed by anything but an operator (`${a:}`, `${a*}`). The
 * braces are read as bash reads them, so `${!a b*}`, which bash reads as a
 * prefix, passes here as it does in bash. `text` runs from `${` through
 * its closing `}`. Mirrors Python's bad_substitution.
 */
export function badSubstitution(text: string): boolean {
  const s = text.slice(2)
  let end = nameEnd(s, 0, s.startsWith('#') && startsName(s.charAt(1)) ? '}' : NAME_ENDS)
  let name = s.slice(0, end)
  if (name === '' && s.startsWith('@')) {
    name = '@'
    end = 1
  } else if (name.startsWith('!') && s.startsWith('@}', end)) {
    name += '@'
    end += 1
  }
  if (
    (name === '' && s !== '' && LENGTH_SPECIALS.includes(s.charAt(0))) ||
    (name === '!' && s.length > 1 && INDIRECT_SPECIALS.includes(s.charAt(1)))
  ) {
    end = nameEnd(s, name.length + 1, SPECIAL_ENDS, false)
    name = s.slice(0, end)
  }
  let c = s.charAt(end)
  let i = end + 1
  let substring = false
  if (c === ':' && s.length > i && NULL_OPERATORS.includes(s.charAt(i))) {
    c = s.charAt(i)
    i += 1
  } else if (c === ':' && s.charAt(i) !== '}') {
    substring = true
  } else if (name === '#' && s.charAt(i) === '}' && c !== '') {
    if (LENGTH_SPECIALS.includes(c)) {
      name += c
      c = '}'
    } else if ('%:=+/'.includes(c)) {
      return true
    }
  }
  const second = name.charAt(1)
  const indirect =
    name.startsWith('!') &&
    second !== '' &&
    (startsName(second) || /[0-9]/.test(second) || INDIRECT_SPECIALS.includes(second))
  if (name.startsWith('#') && name.length > 1) return c !== '}' || !lengthName(name.slice(1))
  const last = name.charAt(name.length - 1)
  if (
    indirect &&
    c === '}' &&
    (('*@'.includes(last) && startsName(second)) || (last === ']' && element(name.slice(1))))
  )
    return false
  const word = indirect ? name.slice(1) : name
  if (word === '' || !lengthName(word)) return true
  return !substring && (c === '' || !OPERATORS.includes(c))
}

function startsName(char: string): boolean {
  return /^[A-Za-z_]$/.test(char)
}

/**
 * Where a name read from `start` stops: at one of `ends`, past a backslash's
 * character and, reading a variable name, past a whole `[...]`.
 */
function nameEnd(text: string, start: number, ends: string, subscripts = true): number {
  let index = start
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (subscripts && char === '[') {
      const close = subscriptEnd(text, index)
      if (close !== null) {
        index = close + 1
        continue
      }
    } else if (ends.includes(char)) {
      return index
    }
    index += 1
  }
  return text.length
}

function subscriptEnd(text: string, start: number): number | null {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1)
      if (close < 0) return null
      index = close
    } else if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return null
}

/** Whether `name` is one whole element reference, `a[...]` with a subscript that is not empty. */
function element(name: string): boolean {
  const bracket = name.indexOf('[')
  if (bracket < 1 || !IDENTIFIER.test(name.slice(0, bracket))) return false
  const close = subscriptEnd(name, bracket)
  return close === name.length - 1 && close > bracket + 1
}

/** Whether `${#name}` measures something. */
function lengthName(name: string): boolean {
  return (
    name === '' ||
    (name.length === 1 && SPECIALS.includes(name)) ||
    DIGITS.test(name) ||
    element(name) ||
    IDENTIFIER.test(name)
  )
}

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

import { CHAR_SEQ, INERT_CLOSE, INERT_OPEN, NUM_SEQ } from './constants.ts'

// Encode an already-expanded chunk as an opaque template atom. Inert
// atoms never contribute brace metacharacters, matching bash's ordering
// where brace expansion runs before parameter and command substitution
// (`{a,$v}` alternates on the atom, `{1..$n}` stays literal). Shell
// input cannot contain NUL, so the sentinels cannot collide.
export function makeInert(index: number): string {
  return `${INERT_OPEN}${String(index)}${INERT_CLOSE}`
}

// Replace inert atoms in an expanded template word with their values.
export function substitute(word: string, values: string[]): string {
  if (!word.includes(INERT_OPEN)) return word
  const out: string[] = []
  let i = 0
  for (;;) {
    const j = word.indexOf(INERT_OPEN, i)
    if (j < 0) {
      out.push(word.slice(i))
      break
    }
    out.push(word.slice(i, j))
    const k = word.indexOf(INERT_CLOSE, j)
    out.push(values[Number(word.slice(j + 1, k))] ?? '')
    i = k + 1
  }
  return out.join('')
}

function isPadded(text: string): boolean {
  const digits = text.startsWith('-') ? text.slice(1) : text
  return digits.length > 1 && digits.startsWith('0')
}

function parseStep(stepText: string | undefined): number {
  if (stepText === undefined) return 1
  const step = Math.abs(Number(stepText))
  return step === 0 ? 1 : step
}

function seqValues(lo: number, hi: number, step: number): number[] {
  const out: number[] = []
  if (lo <= hi) {
    for (let v = lo; v <= hi; v += step) out.push(v)
  } else {
    for (let v = lo; v >= hi; v -= step) out.push(v)
  }
  return out
}

function padValue(v: number, width: number): string {
  const sign = v < 0 ? '-' : ''
  return (
    sign +
    Math.abs(v)
      .toString()
      .padStart(width - sign.length, '0')
  )
}

// Generate `{x..y[..step]}` sequence words, or null if not a range. A
// range body must be pure literal text: an inert atom or escape anywhere
// inside disqualifies it (`{1..$n}` stays literal in bash). Numeric
// endpoints with leading zeros zero-pad every output to the widest
// endpoint, the minus sign counting toward the width ({-05..5..5} yields
// -05 000 005). Step direction follows the endpoints; the step's own
// sign is ignored and 0 acts as 1.
function genSequence(amble: string): string[] | null {
  if (amble.includes(INERT_OPEN) || amble.includes('\\')) return null
  const num = NUM_SEQ.exec(amble)
  if (num !== null) {
    const [, loText = '', hiText = '', stepText] = num
    const values = seqValues(Number(loText), Number(hiText), parseStep(stepText))
    if (isPadded(loText) || isPadded(hiText)) {
      const width = Math.max(loText.length, hiText.length)
      return values.map((v) => padValue(v, width))
    }
    return values.map((v) => String(v))
  }
  const chr = CHAR_SEQ.exec(amble)
  if (chr !== null) {
    const [, loText = '', hiText = '', stepText] = chr
    const values = seqValues(loText.charCodeAt(0), hiText.charCodeAt(0), parseStep(stepText))
    return values.map((v) => String.fromCharCode(v))
  }
  return null
}

function matchClose(text: string, openIdx: number): number {
  let depth = 1
  let i = openIdx + 1
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === INERT_OPEN) {
      i = text.indexOf(INERT_CLOSE, i) + 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

function splitAlternatives(amble: string): string[] | null {
  const alts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  const n = amble.length
  while (i < n) {
    const ch = amble[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === INERT_OPEN) {
      i = amble.indexOf(INERT_CLOSE, i) + 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      alts.push(amble.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  if (alts.length === 0) return null
  alts.push(amble.slice(start))
  return alts
}

function expand(template: string): string[] {
  let i = 0
  const n = template.length
  while (i < n) {
    const ch = template[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === INERT_OPEN) {
      i = template.indexOf(INERT_CLOSE, i) + 1
      continue
    }
    if (ch !== '{') {
      i += 1
      continue
    }
    const close = matchClose(template, i)
    if (close < 0) {
      i += 1
      continue
    }
    const amble = template.slice(i + 1, close)
    let alternatives = genSequence(amble)
    if (alternatives === null) {
      const alts = splitAlternatives(amble)
      if (alts === null) {
        // `{abc}` and friends stay literal; the next `{` (even one
        // inside this body) may still expand, like GNU.
        i += 1
        continue
      }
      alternatives = alts.flatMap((alt) => expand(alt))
    }
    const prefix = template.slice(0, i)
    const suffixes = expand(template.slice(close + 1))
    return alternatives.flatMap((alt) => suffixes.map((suffix) => prefix + alt + suffix))
  }
  return [template]
}

// Brace-expand a template word into its word list. Returns the expanded
// words (inert atoms preserved), or null when the template contains
// nothing brace-expandable so callers can fall back to plain
// concatenation.
export function expandTemplate(template: string): string[] | null {
  const words = expand(template)
  if (words.length === 1 && words[0] === template) return null
  return words
}

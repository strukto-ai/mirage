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

import { RS, type JqError, type JqHalt, type JqOptions, type JqRun } from './types.ts'
import { fsStrerror, isEisdir } from '../../errors/fs.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { concat } from '../../io/cachable_iterator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const NON_ASCII = /[\u0080-\uFFFF]/g
const NUL = new Uint8Array([0])
const NEWLINE = ENC.encode('\n')
const EMPTY = new Uint8Array(0)
const RS_BYTES = ENC.encode(RS)

// What jq's compact dump holds besides its strings and the literals between
// them: the structure. The dump has no whitespace outside a string.
const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const COMMA = 0x2c
const COLON = 0x3a
const STRUCTURE = new Set([OPEN_BRACKET, CLOSE_BRACKET, OPEN_BRACE, CLOSE_BRACE, COMMA, COLON])
const NEWLINE_BYTE = 0x0a
const SPACE = 0x20
const TAB = 0x09

// How jq's main loop fails a run whose output --raw-output0 cannot print.
const NUL_REFUSAL = 'Cannot dump a string containing NUL with --raw-output0 option'

/**
 * jq's dump with every character past ASCII escaped (-a); only a string
 * holds one. One \\uXXXX in lower case per UTF-16 code unit, so a character
 * past U+FFFF escapes as its surrogate pair, which is what jq prints.
 */
function escapeNonAscii(text: string): string {
  return text.replace(NON_ASCII, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

/**
 * The key a member's dumped name spells, which -S orders by: code points
 * order as the UTF-8 bytes jq compares do.
 */
function keyOf(name: string): string {
  return name.includes('\\') ? (JSON.parse(name) as string) : name.slice(1, -1)
}

/**
 * jq's compact dump with every object's keys sorted (-S), built bottom up
 * from the dump one container at a time, so a value nested as deep as jq's
 * parser allows needs no recursion.
 */
function sorted(text: string): string {
  // The open containers, innermost last: each one's opener, the names of an
  // object's members so far, and the values so far. An object holding one
  // more name than values is waiting for that name's value.
  const openers: number[] = []
  const names: string[][] = []
  const values: string[][] = []
  let done = text
  let at = 0
  while (at < text.length) {
    const first = text.charCodeAt(at)
    const start = at
    at += 1
    let token: string
    if (first === OPEN_BRACKET || first === OPEN_BRACE) {
      openers.push(first)
      names.push([])
      values.push([])
      continue
    }
    if (first === COMMA || first === COLON) continue
    if (first === CLOSE_BRACKET || first === CLOSE_BRACE) {
      openers.pop()
      const keys = names.pop() ?? []
      const items = values.pop() ?? []
      if (first === CLOSE_BRACKET) {
        token = `[${items.join(',')}]`
      } else {
        const members = keys.map((name, index) => [keyOf(name), `${name}:${items[index] ?? ''}`])
        members.sort(([a], [b]) => compareCodePoints(a ?? '', b ?? ''))
        token = `{${members.map(([, member]) => member).join(',')}}`
      }
    } else {
      if (first === QUOTE) {
        while (at < text.length) {
          const inner = text.charCodeAt(at)
          at += inner === BACKSLASH ? 2 : 1
          if (inner === QUOTE) break
        }
      } else {
        while (at < text.length && !STRUCTURE.has(text.charCodeAt(at))) at += 1
      }
      token = text.slice(start, at)
    }
    const top = openers.length - 1
    const keys = names[top]
    const items = values[top]
    if (keys === undefined || items === undefined) done = token
    else if (openers[top] === OPEN_BRACE && keys.length === items.length) keys.push(token)
    else items.push(token)
  }
  return done
}

/**
 * jq's pretty dump of a compact one (jv_dump_term with JV_PRINT_PRETTY), as
 * bytes: each member on a line of its own, `width` of `unit` once per level,
 * a space after each colon, and an empty array or object as `[]` or `{}`. A
 * zero width, --indent 0, still breaks the lines. The bytes are copied one
 * at a time; every line break makes room for the rest of the input twice
 * over, as much as a colon's space can take, so nothing between two breaks
 * needs a check.
 */
function indented(bytes: Uint8Array, unit: number, width: number): Uint8Array {
  const end = bytes.length
  let out = new Uint8Array(2 * end + 256)
  let n = 0
  let depth = 0
  let at = 0
  const breakLine = (): void => {
    const count = depth * width
    const need = n + count + 2 + 2 * (end - at)
    if (need > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, need))
      grown.set(out.subarray(0, n))
      out = grown
    }
    out[n++] = NEWLINE_BYTE
    out.fill(unit, n, n + count)
    n += count
  }
  while (at < end) {
    const ch = bytes[at] ?? 0
    out[n++] = ch
    at += 1
    if (ch === QUOTE) {
      while (at < end) {
        const inner = bytes[at] ?? 0
        out[n++] = inner
        at += 1
        if (inner === BACKSLASH) {
          out[n++] = bytes[at] ?? 0
          at += 1
        } else if (inner === QUOTE) {
          break
        }
      }
    } else if (ch === OPEN_BRACKET || ch === OPEN_BRACE) {
      const next = bytes[at]
      if (next === CLOSE_BRACKET || next === CLOSE_BRACE) {
        out[n++] = next
        at += 1
      } else {
        depth += 1
        breakLine()
      }
    } else if (ch === COMMA) {
      breakLine()
    } else if (ch === COLON) {
      out[n++] = SPACE
    } else if (ch === CLOSE_BRACKET || ch === CLOSE_BRACE) {
      n -= 1
      depth -= 1
      breakLine()
      out[n++] = ch
    }
  }
  return out.subarray(0, n)
}

/**
 * One output as jq's main loop dumps it, as bytes: jq's own compact dump
 * (`text`), laid out for -S, -c, --tab, --indent and -a the way
 * jv_dump_term lays them out.
 */
function dumpBytes(text: string, opts: JqOptions): Uint8Array {
  let out = opts.asciiOutput ? escapeNonAscii(text) : text
  if (opts.sortKeys) out = sorted(out)
  const bytes = ENC.encode(out)
  if (opts.compact) return bytes
  return opts.tab ? indented(bytes, TAB, 1) : indented(bytes, SPACE, opts.indent)
}

/** One output as jq's main loop dumps it (see dumpBytes). */
export function dumpText(text: string, opts: JqOptions): string {
  return DEC.decode(dumpBytes(text, opts))
}

function terminator(opts: JqOptions): Uint8Array {
  // --raw-output0 wins over -j whichever order they were typed, which is
  // what jq does.
  if (opts.nulOutput) return NUL
  return opts.joinOutput ? EMPTY : NEWLINE
}

/** Render one output, jq's compact dump of it, with its separator. */
export function formatOne(text: string, opts: JqOptions): Uint8Array {
  const raw = opts.rawOutput && text.startsWith('"')
  // -a beats -r: jq writes a string quoted and escaped under --ascii-output,
  // dumped with that flag alone, even when raw output was asked for.
  let body: Uint8Array
  if (raw && !opts.asciiOutput) body = ENC.encode(JSON.parse(text) as string)
  else if (raw) body = ENC.encode(escapeNonAscii(text))
  else body = dumpBytes(text, opts)
  // RFC 7464 puts the separator before the value, not after it, and jq
  // writes none before a string it prints raw, quoted by -a or not.
  const prefix = opts.seq && !raw ? RS_BYTES : EMPTY
  return concat([prefix, body, terminator(opts)])
}

/** Render every output of a jq program, jq's compact dump of each, one per line. */
export function formatJqOutput(texts: readonly string[], opts: JqOptions): Uint8Array {
  const parts: Uint8Array[] = []
  for (const text of texts) parts.push(formatOne(text, opts))
  return concat(parts)
}

/**
 * The run as jq's main loop gets to print it: --raw-output0 refuses a raw
 * string that holds a NUL, which ends the run with an error there, the
 * outputs before it printed.
 */
export function printable(run: JqRun<string>, opts: JqOptions): JqRun<string> {
  if (!opts.nulOutput || opts.asciiOutput) return run
  const at = run.outputs.findIndex(
    (text) =>
      text.startsWith('"') &&
      text.includes('\\u0000') &&
      (JSON.parse(text) as string).includes('\0'),
  )
  if (at < 0) return run
  return {
    outputs: run.outputs.slice(0, at),
    stop: { kind: 'error', text: NUL_REFUSAL, string: true },
  }
}

/**
 * jq's report of an error no `try` caught, which it writes to stderr. A
 * string message is printed the way C prints a string, so it ends at a
 * NUL.
 */
export function errorReport(position: string, error: JqError): string {
  if (error.string) {
    const text = error.text.split('\0', 1)[0] ?? ''
    return `jq: error (at ${position}): ${text}\n`
  }
  return `jq: error (at ${position}) (not a string): ${error.text}\n`
}

/**
 * Why jq could not load a whole file (jv_load_file): an -f program, a
 * --rawfile or a --slurpfile, named as typed. It opens the file itself, so a
 * directory gets words of its own instead of a failed read.
 */
export function loadFailure(name: string, err: unknown): string {
  if (isEisdir(err)) return `Could not open ${name}: It's a directory`
  return `Could not open ${name}: ${fsStrerror(err) ?? ''}`
}

/**
 * What jq writes to stderr for a halt: a string as it is, anything else
 * dumped on a line of its own, and nothing for `halt` or a null.
 */
export function haltReport(halt: JqHalt): string {
  if (halt.message === null) return ''
  return halt.string ? halt.message : `${halt.message}\n`
}

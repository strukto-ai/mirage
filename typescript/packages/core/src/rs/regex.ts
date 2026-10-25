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

import { z } from 'zod'
import type { util } from 'zod'
import { fromByteView } from '../shell/bytes.ts'
import { RegexError, StreamRefusal } from './errors.ts'
import type { OpenStream } from './stream.ts'
import { openStreamSync } from './stream.ts'

export type Span = [number, number]
export type Groups = (Span | null)[]
export type PosixDialect = 'sed' | 'posix'
export type LineSyntax = 'basic' | 'extended' | 'fixed' | 'perl'

const UNSET = 0xffffffff
const SPECIAL = /[\\.[\]()*+?{}|^$]/g
const decoder = new TextDecoder()
const finalizer = new FinalizationRegistry<OpenStream>((stream) => {
  stream.close()
})
const posixMeta = z.object({ groups: z.number().int().nonnegative() })
const lineMeta = z.object({
  warnings: z.array(z.string()),
  needles: z.array(z.string()).nullable(),
})

/** `text` as a POSIX extended expression that matches only itself. Mirrors Python's posix_escape. */
export function posixEscape(text: string): string {
  return text.replace(SPECIAL, '\\$&')
}

function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let at = 0; at < bytes.length; at += 4096)
    out += String.fromCharCode(...bytes.subarray(at, at + 4096))
  return out
}

function byteLength(code: number): number {
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  // A byte that is no part of a character rides as its surrogate escape.
  if (code >= 0xdc80 && code <= 0xdcff) return 1
  return 3
}

/**
 * A byte view as the bytes mirage-rs searches, and the way back from a byte
 * offset to an index of the view. Mirrors Python's `_Subject`.
 */
class Subject {
  readonly data: Uint8Array
  private readonly starts: Int32Array | null

  constructor(text: string, utf8: boolean) {
    this.data = fromByteView(text, utf8)
    if (this.data.length === text.length) {
      this.starts = null
      return
    }
    const starts = new Int32Array(text.length + 1)
    let offset = 0
    for (let i = 0; i < text.length; i++) {
      starts[i] = offset
      const code = text.charCodeAt(i)
      const next = text.charCodeAt(i + 1)
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        starts[i + 1] = offset
        offset += 4
        i++
        continue
      }
      offset += byteLength(code)
    }
    starts[text.length] = offset
    this.starts = starts
  }

  offset(index: number): number {
    return this.starts === null ? index : (this.starts[index] ?? index)
  }

  index(offset: number): number {
    const starts = this.starts
    if (starts === null) return offset
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high) >> 1
      if ((starts[mid] ?? 0) < offset) low = mid + 1
      else high = mid
    }
    return low
  }
}

function words(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: number[] = []
  for (let at = 0; at + 4 <= data.byteLength; at += 4) out.push(view.getUint32(at, true))
  return out
}

function open(config: Readonly<Record<string, util.JSONType>>): OpenStream {
  try {
    return openStreamSync('regex', config, true)
  } catch (err) {
    if (err instanceof StreamRefusal) throw new RegexError(err.message)
    throw err
  }
}

/**
 * One POSIX expression, searched against whole subjects. A match is the
 * leftmost one and the longest there; its groups lie where the first way of
 * matching that text puts them, trying a repetition's longer counts and an
 * alternation's earlier branches first. Offsets count elements of the byte
 * view the subject arrives as. `dialect` `sed` reads the expression as GNU
 * sed does, `posix` as regcomp does for expr, nl, bash and git; `multiline`
 * is sed's `M`, and `word` git grep's -w. A refused expression throws
 * RegexError in regerror's wording. Mirrors Python's PosixRegex.
 */
export class PosixRegex {
  readonly groups: number
  private readonly config: Readonly<Record<string, util.JSONType>>
  private stream: OpenStream

  constructor(
    pattern: string,
    extended = false,
    dialect: PosixDialect = 'posix',
    ignoreCase = false,
    readonly utf8 = false,
    multiline = false,
    word = false,
  ) {
    this.config = {
      mode: 'posix',
      pattern: latin1(fromByteView(pattern, utf8)),
      extended,
      dialect,
      ignore_case: ignoreCase,
      utf8,
      multiline,
      word,
    }
    this.stream = open(this.config)
    finalizer.register(this, this.stream)
    this.groups = posixMeta.parse(JSON.parse(decoder.decode(this.stream.metadata()))).groups
  }

  // The stream, opened again when the instance it was on retired.
  private live(): OpenStream {
    if (!this.stream.live) {
      this.stream = open(this.config)
      finalizer.register(this, this.stream)
    }
    return this.stream
  }

  private ask(subject: Subject, request: Readonly<Record<string, util.JSONType>>): number[] {
    const stream = this.live()
    stream.begin(request)
    stream.feed(subject.data)
    return words(stream.finish())
  }

  private spans(subject: Subject, found: readonly number[]): Groups {
    const out: Groups = []
    for (let at = 0; at + 1 < found.length; at += 2) {
      const start = found[at] ?? UNSET
      const end = found[at + 1] ?? UNSET
      out.push(start === UNSET ? null : [subject.index(start), subject.index(end)])
    }
    return out
  }

  /** The leftmost-longest match at or after `at`, and its groups. */
  search(text: string, at = 0): Groups | null {
    const subject = new Subject(text, this.utf8)
    const found = this.ask(subject, { op: 'search', at: subject.offset(at) })
    return found.length === 0 ? null : this.spans(subject, found)
  }

  /** Every match a global substitution replaces, as sed walks them. */
  all(text: string): Groups[] {
    const subject = new Subject(text, this.utf8)
    const found = this.ask(subject, { op: 'all' })
    const width = 2 * (this.groups + 1)
    const out: Groups[] = []
    for (let at = 0; at < found.length; at += width)
      out.push(this.spans(subject, found.slice(at, at + width)))
    return out
  }

  /**
   * How many times git's pickaxe counts the expression in `text`: each match
   * stays in its line, each search resumes where the last one ended (a
   * character further after an empty one), and `^` never holds where it
   * resumes.
   */
  contains(text: string): number {
    return this.ask(new Subject(text, this.utf8), { op: 'contains' })[0] ?? 0
  }

  /**
   * Whether the expression matches anywhere in `text`, as sed's addresses
   * ask: with no groups to place, a `$` reads a newline the match goes on to
   * consume even in a pattern with groups.
   */
  matches(text: string): boolean {
    return this.ask(new Subject(text, this.utf8), { op: 'test' })[0] === 1
  }
}

const CACHE_SIZE = 256
const cache = new Map<string, PosixRegex>()

/** A compiled PosixRegex, shared by every caller asking the same. Mirrors Python's posix_regex. */
export function posixRegex(
  pattern: string,
  extended = false,
  dialect: PosixDialect = 'posix',
  ignoreCase = false,
  utf8 = false,
  multiline = false,
  word = false,
): PosixRegex {
  const key = JSON.stringify([pattern, extended, dialect, ignoreCase, utf8, multiline, word])
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const regex = new PosixRegex(pattern, extended, dialect, ignoreCase, utf8, multiline, word)
  cache.set(key, regex)
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return regex
}

/**
 * grep's pattern list, matched against one line at a time: a line matches
 * when any pattern does, and `extents` reads matches as -o prints them, the
 * leftmost and longest across the list. `line` (-x) outranks `word` (-w). A
 * refused pattern throws RegexError in GNU grep's wording. Mirrors Python's
 * LineRegex.
 */
export class LineRegex {
  readonly warnings: readonly string[]
  readonly needles: string[] | null
  /** Letters fold by Unicode, so `ſ` matches `s` and the Kelvin sign `k`. */
  readonly unicodeFolds: boolean
  private readonly config: Readonly<Record<string, util.JSONType>>
  private stream: OpenStream

  constructor(
    patterns: readonly string[],
    syntax: LineSyntax,
    readonly ignoreCase = false,
    private readonly utf8 = false,
    word = false,
    line = false,
  ) {
    this.config = {
      mode: 'lines',
      patterns: patterns.map((part) => latin1(fromByteView(part, utf8))),
      syntax,
      ignore_case: ignoreCase,
      utf8,
      word,
      line,
    }
    this.stream = open(this.config)
    finalizer.register(this, this.stream)
    this.unicodeFolds = ignoreCase && utf8
    const meta = lineMeta.parse(JSON.parse(decoder.decode(this.stream.metadata())))
    this.warnings = meta.warnings
    this.needles = meta.needles
  }

  // The stream, opened again when the instance it was on retired.
  private live(): OpenStream {
    if (!this.stream.live) {
      this.stream = open(this.config)
      finalizer.register(this, this.stream)
    }
    return this.stream
  }

  private ask(subject: Subject, op: string): Uint8Array {
    const stream = this.live()
    stream.begin({ op })
    stream.feed(subject.data)
    return stream.finish()
  }

  /** Whether the line, without its terminator, matches. */
  matches(line: string): boolean {
    return this.ask(new Subject(line, this.utf8), 'test')[0] === 1
  }

  /** Each match grep -o prints from the line. */
  extents(line: string): Span[] {
    const subject = new Subject(line, this.utf8)
    const found = words(this.ask(subject, 'extents'))
    const out: Span[] = []
    for (let at = 0; at + 1 < found.length; at += 2)
      out.push([subject.index(found[at] ?? 0), subject.index(found[at + 1] ?? 0)])
    return out
  }
}

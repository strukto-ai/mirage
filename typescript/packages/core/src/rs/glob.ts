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
import { YieldBudget } from '../io/yield_budget.ts'
import type { OpenStream } from './stream.ts'
import { MovableStream, openStreamSync } from './stream.ts'

const position = z.number().int().nonnegative().nullable()
const units = z.array(z.number().int().min(0).max(0x10ffff))
const spans = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]))
const finalizer = new FinalizationRegistry<OpenStream>((stream) => {
  stream.close()
})
const decoder = new TextDecoder()
const CHUNK = 4096
const CACHE_SIZE = 256
const scratch = new Uint8Array(4 * CHUNK)

interface Plain {
  kind: 'matches' | 'shape' | 'parts'
}
interface End {
  kind: 'end'
  start: number
  longest: boolean
}
interface Suffix {
  kind: 'suffix'
  longest: boolean
}
interface Replace {
  kind: 'replace'
  all: boolean
  anchor: string | null
}
type Operation = Plain | End | Suffix | Replace
type Reply = boolean | number | null | number[] | number[][]
type Dialect = 'shell' | 'python'

// The code points as little-endian u32 units. A `transient` result may be the
// shared scratch, good until the next transient call: for a caller that hands
// it to Wasm before it awaits.
function encoded(text: string, transient = false): Uint8Array {
  const bytes = transient && text.length <= CHUNK ? scratch : new Uint8Array(4 * text.length)
  const view = new DataView(bytes.buffer)
  let size = 0
  for (let at = 0; at < text.length; size += 4) {
    const unit = text.codePointAt(at) ?? 0
    view.setUint32(size, unit, true)
    at += unit > 0xffff ? 2 : 1
  }
  return bytes.subarray(0, size)
}

// The text encoded a piece of about CHUNK characters at a time, never splitting
// a surrogate pair, for a caller that yields between pieces.
function* pieces(text: string): Generator<Uint8Array> {
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + CHUNK, text.length)
    if ((text.codePointAt(end - 1) ?? 0) > 0xffff) end += 1
    yield encoded(text.slice(at, end))
    at = end
  }
}

function config(
  pattern: string,
  extglob: boolean,
  period: boolean,
  dialect: Dialect,
): Readonly<Record<string, util.JSONType>> {
  return {
    pattern: Array.from(pattern, (ch) => ch.codePointAt(0) ?? 0),
    extglob,
    period,
    dialect,
    operation: { kind: 'matches' },
  }
}

function reply(stream: OpenStream): Reply {
  let out = decoder.decode(stream.finish())
  while (stream.busy()) out += decoder.decode(stream.drain())
  return JSON.parse(out) as Reply
}

function text(result: readonly number[]): string {
  return result.map((unit) => String.fromCodePoint(unit)).join('')
}

/** One compiled pattern. Offsets count supplied characters, including lone surrogates. */
export class Glob {
  private readonly stream: OpenStream
  private subject: string | undefined
  private readonly budget: YieldBudget

  constructor(
    pattern: string,
    extglob = false,
    period = false,
    dialect: Dialect = 'shell',
    signal?: AbortSignal,
  ) {
    this.budget = new YieldBudget(signal)
    this.stream = openStreamSync('glob', config(pattern, extglob, period, dialect))
    finalizer.register(this, this.stream, this)
  }

  close(): void {
    finalizer.unregister(this)
    this.stream.close()
    this.subject = undefined
  }

  private prepare(name: string, operation: Operation): boolean {
    const reuse = this.subject === name
    this.stream.begin({ ...operation, reuse_subject: reuse })
    this.subject = name
    return reuse
  }

  private run(name: string, operation: Operation): Reply {
    if (!this.prepare(name, operation)) this.stream.feed(encoded(name, true))
    return reply(this.stream)
  }

  private async runAsync(name: string, operation: Operation): Promise<Reply> {
    const budget = this.budget
    if (!this.prepare(name, operation)) {
      for (const part of pieces(name)) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        this.stream.feed(part)
      }
    }
    let out = decoder.decode(this.stream.finish())
    while (this.stream.busy()) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      out += decoder.decode(this.stream.drain())
    }
    return JSON.parse(out) as Reply
  }

  async matchesAsync(name: string): Promise<boolean> {
    return z.boolean().parse(await this.runAsync(name, { kind: 'matches' }))
  }

  end(name: string, start: number, longest = true): number | null {
    return position.parse(this.run(name, { kind: 'end', start, longest }))
  }

  suffix(name: string, longest = true): number | null {
    return position.parse(this.run(name, { kind: 'suffix', longest }))
  }

  async extent(name: string, prefix: boolean, longest: boolean): Promise<number | null> {
    return position.parse(
      await this.runAsync(
        name,
        prefix ? { kind: 'end', start: 0, longest } : { kind: 'suffix', longest },
      ),
    )
  }

  async spans(name: string, all: boolean, anchor: string | null): Promise<[number, number][]> {
    return spans.parse(await this.runAsync(name, { kind: 'replace', all, anchor }))
  }

  shape(): string {
    return text(units.parse(this.run('', { kind: 'shape' })))
  }

  parts(): string[] {
    return z
      .array(units)
      .parse(this.run('', { kind: 'parts' }))
      .map(text)
  }
}

/**
 * One compiled pattern asked whether whole names match, one Wasm call per name,
 * or none where the grammar reads the pattern as plain text and the name is
 * compared with it here. Mirrors Python's GlobMatcher.
 */
export class GlobMatcher {
  private readonly stream: MovableStream
  private readonly literal: string | null

  constructor(pattern: string, extglob = false, period = false, dialect: Dialect = 'shell') {
    this.stream = new MovableStream('glob', config(pattern, extglob, period, dialect))
    const stream = this.stream.live
    stream.begin({ kind: 'literal' })
    const literal = units.nullable().parse(reply(stream))
    this.literal = literal === null ? null : text(literal)
  }

  matches(name: string): boolean {
    if (this.literal !== null) return name === this.literal
    return this.stream.live.test(encoded(name, true))
  }
}

const matchers = new Map<string, (GlobMatcher | undefined)[]>()

/**
 * A compiled GlobMatcher, shared by every caller asking the same; the pattern
 * compiled first leaves first. A hit is one lookup, since a filter asks once
 * per name. Mirrors Python's glob_matcher.
 */
export function globMatcher(
  pattern: string,
  extglob = false,
  period = false,
  dialect: Dialect = 'shell',
): GlobMatcher {
  let kinds = matchers.get(pattern)
  if (kinds === undefined) {
    const oldest = matchers.keys().next().value
    if (matchers.size >= CACHE_SIZE && oldest !== undefined) matchers.delete(oldest)
    kinds = []
    matchers.set(pattern, kinds)
  }
  const kind = (dialect === 'python' ? 4 : 0) + (extglob ? 2 : 0) + (period ? 1 : 0)
  return (kinds[kind] ??= new GlobMatcher(pattern, extglob, period, dialect))
}

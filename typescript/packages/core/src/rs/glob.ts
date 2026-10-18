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
import { YieldBudget } from '../io/yield_budget.ts'
import type { OpenStream } from './stream.ts'
import { openStreamSync } from './stream.ts'

const position = z.number().int().nonnegative().nullable()
const units = z.array(z.number().int().min(0).max(0x10ffff))
const spans = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]))
const finalizer = new FinalizationRegistry<OpenStream>((stream) => {
  stream.close()
})
const decoder = new TextDecoder()

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

function* encodedUnits(text: string): Generator<Uint8Array> {
  let buffer = new Uint8Array(16 * 1024)
  let view = new DataView(buffer.buffer)
  let size = 0
  for (const char of text) {
    view.setUint32(size, char.codePointAt(0) ?? 0, true)
    size += 4
    if (size === buffer.length) {
      yield buffer
      buffer = new Uint8Array(16 * 1024)
      view = new DataView(buffer.buffer)
      size = 0
    }
  }
  if (size > 0) yield buffer.subarray(0, size)
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
    dialect: 'shell' | 'python' = 'shell',
    signal?: AbortSignal,
  ) {
    this.budget = new YieldBudget(signal)
    this.stream = openStreamSync('glob', {
      pattern: Array.from(pattern, (ch) => ch.codePointAt(0) ?? 0),
      extglob,
      period,
      dialect,
      operation: { kind: 'matches' },
    })
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

  private run(name: string, operation: Operation): unknown {
    if (!this.prepare(name, operation)) {
      for (const part of encodedUnits(name)) this.stream.feed(part)
    }
    let out = decoder.decode(this.stream.finish())
    while (this.stream.busy()) out += decoder.decode(this.stream.drain())
    return JSON.parse(out)
  }

  private async runAsync(name: string, operation: Operation): Promise<unknown> {
    const budget = this.budget
    if (!this.prepare(name, operation)) {
      for (const part of encodedUnits(name)) {
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
    return JSON.parse(out)
  }

  matches(name: string): boolean {
    return z.boolean().parse(this.run(name, { kind: 'matches' }))
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

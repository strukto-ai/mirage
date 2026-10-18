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

import { closeCodec, runCodec } from './codec.ts'
import { JqParseError, NO_VALUE, type NoValue } from './types.ts'
import { CHUNK_SIZE } from '../../io/cooperative.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { openStream, type OpenStream } from '../../rs/stream.ts'
import { concat } from '../../utils/bytes.ts'

const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

/** Decode raw bytes using jq's malformed sequence rules. */
export async function decodeUtf8(data: Uint8Array, signal?: AbortSignal): Promise<string> {
  const parts: Uint8Array[] = []
  for await (const part of runCodec('jq_decode', {}, data, signal)) parts.push(part)
  return DEC.decode(concat(parts))
}

/** Bytes needed to finish a jq reader piece's final UTF-8 character. */
export function utf8Missing(piece: Uint8Array): number {
  let at = piece.length - 1
  if (at <= 0) return 0
  let seen = 1
  for (;;) {
    const byte = piece[at] ?? 0
    if (byte < 0x80 || byte >= 0xc0 || at === 0) break
    at -= 1
    seen += 1
  }
  const first = piece[at] ?? 0
  const length =
    first < 0x80
      ? 1
      : first >= 0xc2 && first < 0xe0
        ? 2
        : first >= 0xe0 && first < 0xf0
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 0
  return Math.max(0, length - seen)
}

/** Quote a host string for the evaluator. */
export function stringText(value: string): string {
  return JSON.stringify(value)
}

/** A literal-preserving text scanner over the shared Rust grammar. */
export class JqParser {
  private stream: OpenStream | undefined
  private readonly budget: YieldBudget
  private input: Uint8Array = new Uint8Array(0)
  private at = 0
  private final = false
  private finished = false
  private wire: Uint8Array = new Uint8Array(0)
  private parts: Uint8Array[] = []

  constructor(
    private readonly seq = false,
    private readonly streaming = false,
    signal?: AbortSignal,
  ) {
    this.budget = new YieldBudget(signal)
  }

  /** Offer one reader piece; EOF belongs to the whole input stream. */
  feed(data: Uint8Array, partial: boolean): void {
    this.input = data
    this.at = 0
    this.final = !partial
  }

  async close(): Promise<void> {
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) await closeCodec(stream)
  }

  /** Return the next text, parse failure, or NO_VALUE when input is needed. */
  async next(): Promise<string | JqParseError | NoValue> {
    const stream = (this.stream ??= await openStream('jq_scan', {
      seq: this.seq,
      streaming: this.streaming,
    }))
    for (;;) {
      if (this.wire.length >= 5) {
        const size = new DataView(this.wire.buffer, this.wire.byteOffset, 5).getUint32(1, true)
        if (this.wire.length >= size + 5) {
          const tag = this.wire[0]
          const payload = this.wire.slice(5, size + 5)
          this.wire = this.wire.slice(size + 5)
          if (tag === 1) this.parts.push(payload)
          else if (tag === 2) {
            const text = DEC.decode(concat(this.parts))
            this.parts = []
            return text
          } else if (tag === 3) return new JqParseError(DEC.decode(payload))
          else throw new Error('unknown jq scanner frame')
          continue
        }
      }
      const pending = this.budget.run()
      if (pending !== undefined) await pending
      let output: Uint8Array
      if (stream.busy()) output = stream.drain()
      else if (this.at < this.input.length) {
        const stop = this.at + CHUNK_SIZE
        output = stream.feed(this.input.subarray(this.at, stop))
        this.at = Math.min(stop, this.input.length)
      } else if (this.final && !this.finished) {
        this.finished = true
        output = stream.finish()
      } else return NO_VALUE
      if (output.length > 0) this.wire = concat([this.wire, output])
    }
  }
}

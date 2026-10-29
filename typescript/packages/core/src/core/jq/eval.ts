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

import { JqCompileError } from './errors.ts'
import type { JqError, JqHalt } from './types.ts'
import { MemoryExhausted } from '../../io/errors.ts'
import { memoryRoom } from '../../io/memory.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { StreamRefusal } from '../../rs/errors.ts'
import { closeStream, openStream, type OpenStream } from '../../rs/stream.ts'
import { TZ_VAR } from '../../utils/timezone.ts'

const DEC = new TextDecoder('utf-8', { ignoreBOM: true })
const ENC = new TextEncoder()

export const FRAME_OUTPUT = 1
export const FRAME_ERROR = 2
export const FRAME_HALT = 3
export const FRAME_DEBUG = 4
export const FRAME_STDERR = 5

// The last line of jq's report of a program it refuses, which jq_eval's
// refusal to compile such a program ends in. Mirrors Python's
// COMPILE_REPORT.
export const COMPILE_REPORT = /(?:^|\n)jq: [0-9]+ compile errors?$/

// The error jq_eval ends a run with once it holds more than its memory, with
// the bytes. Mirrors Python's MEMORY_REPORT.
export const MEMORY_REPORT = 'jq memory limit of {} bytes exceeded'

/**
 * The time zone jq's local time reads, as a `TZ` value: the command
 * environment's, else the process's, else the host's own zone.
 */
export function localZone(env: Record<string, string> | undefined): string {
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> }
  }
  return (
    env?.[TZ_VAR] ?? host.process?.env?.[TZ_VAR] ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )
}

/**
 * How a run whose outputs went out as it made them ended: the error or halt
 * that stopped it, if one did.
 */
export interface Ending {
  stop: JqError | JqHalt | null
}

/**
 * Fold one drain of mirage-rs's jq_eval into a run: each output frame is a
 * compact dump, pushed onto `outputs`, a `debug` or `stderr` frame is
 * dropped, and an error or a halt frame is what stopped the run. A frame is a
 * tag, a little-endian u32 length and its payload; an error's flag byte says
 * whether it is a string (bit 0) and whether the program raised it with
 * `error` itself (bit 1).
 */
export function readFrames(bytes: Uint8Array, outputs: Uint8Array[]): JqError | JqHalt | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let stop: JqError | JqHalt | null = null
  let at = 0
  while (at < bytes.byteLength) {
    if (at + 5 > bytes.byteLength) throw new Error('jq_eval: truncated frame header')
    const tag = view.getUint8(at)
    const end = at + 5 + view.getUint32(at + 1, true)
    if (end > bytes.byteLength) throw new Error('jq_eval: truncated frame')
    const payload = bytes.subarray(at + 5, end)
    at = end
    if (tag === FRAME_OUTPUT) {
      outputs.push(payload)
    } else if (tag === FRAME_ERROR) {
      const flags = payload[0] ?? 0
      stop = {
        kind: 'error',
        text: DEC.decode(payload.subarray(1)),
        string: (flags & 1) === 1,
        own: (flags & 2) === 2,
      }
    } else if (tag === FRAME_HALT) {
      const halt = JSON.parse(DEC.decode(payload)) as Omit<JqHalt, 'kind'>
      stop = { kind: 'halt', message: halt.message, string: halt.string, code: halt.code }
    } else if (tag !== FRAME_DEBUG && tag !== FRAME_STDERR) {
      throw new Error(`jq_eval: unknown frame ${String(tag)}`)
    }
  }
  return stop
}

/**
 * A program compiled once by mirage-rs's jq_eval and run on one value at a
 * time on this thread, a bounded number of VM steps per drain, so a program
 * that never ends still yields and the signal can stop it between two.
 * `input` finds no more input, `$ENV` is the given environment, and what
 * `debug` and `stderr` write is dropped, as `gh --jq` evaluates. Mirrors
 * Python's Engine.
 */
export class Engine {
  private readonly budget: YieldBudget

  // What the workspace's max_memory had left when the program compiled, the
  // bytes the run may hold; null for jq_eval's own.
  private constructor(
    private readonly stream: OpenStream,
    private readonly memory: number | null,
    signal?: AbortSignal,
  ) {
    this.budget = new YieldBudget(signal)
  }

  /**
   * Compile `expr`, as typed, with `env` (JSON text) as `$ENV` and `env` and
   * `zone` (localZone) as the `TZ` local time reads. Throws JqCompileError,
   * with jq's report, for a program jq itself refuses.
   */
  static async open(
    expr: string,
    env: string,
    zone: string,
    signal?: AbortSignal,
  ): Promise<Engine> {
    let stream: OpenStream
    const limit = memoryRoom()
    try {
      stream = await openStream('jq_eval', {
        program: expr,
        env,
        zone,
        ...(limit === null ? {} : { memory: limit }),
      })
    } catch (error) {
      if (error instanceof StreamRefusal && COMPILE_REPORT.test(error.message)) {
        throw new JqCompileError(error.message)
      }
      throw error
    }
    return new Engine(stream, limit, signal)
  }

  /**
   * Run the program on one value's JSON text, yielding each output's compact
   * dump as a drain decodes it, and leave on `ending` how the run stopped. A
   * run its caller stops reading is cancelled, so the next can begin.
   */
  async *run(doc: string, ending: Ending): AsyncGenerator<string, void, undefined> {
    const stream = this.stream
    stream.begin({ filename: null, line: 0 })
    const outputs: Uint8Array[] = []
    let stop: JqError | JqHalt | null
    // Whether the caller stopped reading while the run was still going.
    let abandoned = true
    try {
      stop = readFrames(stream.feed(ENC.encode(doc)), outputs)
      stop = readFrames(stream.finish(), outputs) ?? stop
      for (;;) {
        for (const output of outputs) yield DEC.decode(output)
        outputs.length = 0
        let wire: Uint8Array
        if (stream.busy()) {
          const pending = this.budget.run()
          if (pending !== undefined) await pending
          wire = stream.drain()
        } else {
          const asked = stream.request()
          if (asked === null) break
          if (asked[0].op === 'now') {
            wire = stream.respond({ kind: 'now', now: Date.now() / 1000 }, new Uint8Array())
          } else if (asked[0].op === 'input') {
            wire = stream.respond({ kind: 'end' }, new Uint8Array())
          } else {
            throw new Error(`jq_eval: unknown host request ${JSON.stringify(asked[0])}`)
          }
        }
        stop = readFrames(wire, outputs) ?? stop
      }
      abandoned = false
    } catch (error) {
      abandoned = false
      throw error
    } finally {
      if (abandoned && stream.cancel()) {
        while (stream.busy()) {
          const pending = this.budget.run()
          if (pending !== undefined) await pending
          stream.drain()
        }
      }
    }
    if (
      this.memory !== null &&
      stop?.kind === 'error' &&
      stop.text === MEMORY_REPORT.replace('{}', String(this.memory))
    ) {
      throw new MemoryExhausted()
    }
    ending.stop = stop
  }

  /** Close the program; a run cut short is retired a bounded slice at a time. */
  close(): Promise<void> {
    return closeStream(this.stream)
  }
}

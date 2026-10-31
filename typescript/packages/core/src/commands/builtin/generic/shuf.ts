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

import { type util } from 'zod'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { usageHint } from '../../spec/usage.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { CHUNK_SIZE, chunks } from '../../../io/cooperative.ts'
import { OutputStream, closeQuietly, rechunk } from '../../../io/stream.ts'
import {
  closeStream,
  openStream,
  runStream,
  serveRequests,
  type OpenStream,
  type Served,
} from '../../../rs/stream.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { mountRoot } from '../utils/links.ts'
import { type IdSource, SystemIdSource } from '../../../utils/ids.ts'

const ENC = new TextEncoder()

// A `-o` reached a backend wired without a write op, which is a wiring fault
// rather than anything the command line did wrong, so it is thrown as a bare
// Error rather than returned like every user-facing refusal.
export const NO_WRITE_OP = 'shuf: backend provides no write op'

// GNU's own out-of-memory wording, exit 1. It is what real shuf answers with
// when a range is too large to materialize, so it is borrowed rather than
// invented. Measured, ground truth SH5.
export const MEMORY_EXHAUSTED = 'shuf: memory exhausted'

const TRY_HELP = `\n${usageHint('shuf')}`

// Preserve the existing one-million-record output limit. Output now streams;
// this limit bounds shuffle indexes and sampling state, not rendered bytes.
// GNU has no fixed ceiling and may enumerate larger populations.
export const MAX_OUTPUT_LINES = 1000000n

// How many lines shuf will emit, before any of them are built.
//
// Computed rather than discovered, because `-i` can name 2**64 values and GNU
// answers `-i 1-18446744073709551615 -n 3` instantly by never building the
// population (SH5). Knowing the emitted count up front is what lets the range
// path sample instead of enumerate, and what lets an output larger than
// MAX_OUTPUT_LINES be refused without allocating it.
//
// `-r` draws independently, so it emits exactly the requested count however few
// values it is drawing from -- except from nothing at all, which emits nothing.
// Without `-r` the count is a head count over a permutation, so it cannot
// exceed what is available.
//
// `emit_count` in shuf.py is the twin.
export function emitCount(
  available: bigint,
  count: bigint | null,
  withReplacement: boolean,
): bigint {
  if (withReplacement) {
    if (available === 0n) return 0n
    return count ?? available
  }
  if (count === null) return available
  return count < available ? count : available
}

export interface ShufFlags {
  // `bigint`: a count is clamped at SIZE_MAX and a bound reaches it, past
  // what a float64 keeps exact.
  readonly count: bigint | null
  readonly echo: boolean
  readonly zeroTerminated: boolean
  readonly withReplacement: boolean
  readonly inputRange: readonly [bigint, bigint] | null
  // The last `-o`, a PathSpec as every PATH-typed flag arrives.
  readonly output: PathSpec | null
}

/**
 * shuf's options, `-n`, `-i`, `-o` and `-e` read by mirage-rs before any
 * operand is resolved, each where it was typed; the refusal as an IOResult
 * otherwise. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): ShufFlags | IOResult {
  const fl = new FlagView(bag, specOf('shuf'))
  // GNU compares two -o by the words typed, which the tape holds resolved.
  const words = fl.asPaths('output').map((p) => (p.rawPath !== '' ? p.rawPath : p.virtual))
  const typed = fl
    .texts('head_count', 'input_range', 'output', 'echo')
    .map(([name, text]): [string, string] => [
      name,
      name === 'output' ? (words.shift() ?? text) : text,
    ])
  let values
  try {
    values = scan('shuf', typed)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { count, range } = values
  if (count !== null && typeof count !== 'string') {
    throw new Error(`shuf: mirage-rs read -n as ${JSON.stringify(count)}`)
  }
  let inputRange: readonly [bigint, bigint] | null = null
  if (range !== null) {
    const [low, high] = Array.isArray(range) && range.length === 2 ? range : []
    if (typeof low !== 'string' || typeof high !== 'string') {
      throw new Error(`shuf: mirage-rs read -i as ${JSON.stringify(range)}`)
    }
    inputRange = [BigInt(low), BigInt(high)]
  }
  return {
    count: count === null ? null : BigInt(count),
    echo: fl.asBool('echo'),
    zeroTerminated: fl.asBool('zero_terminated'),
    withReplacement: fl.asBool('repeat'),
    inputRange,
    output: fl.asPaths('output').at(-1) ?? null,
  }
}

class ShufHost {
  readonly errors = new ByteSpool()
  private closed = false
  constructor(
    readonly ids: IdSource,
    readonly stream: OpenStream,
    readonly spools: Map<number, ByteSpool>,
  ) {}

  async serve(request: Readonly<Record<string, util.JSONType>>, data: Uint8Array): Promise<Served> {
    if (request.op === 'words')
      return { reply: {}, data: this.ids.randomWords(Number(request.count)) }
    const id = Number(request.spool ?? (request.op === 'swap' || request.index === true ? 1 : 0))
    if (request.op === 'close') {
      const store = this.spools.get(id)
      this.spools.delete(id)
      await store?.close()
      return { reply: {} }
    }
    if (request.op === 'write') {
      let store = this.spools.get(id)
      if (store === undefined) {
        store = new ByteSpool(0)
        this.spools.set(id, store)
      }
      await store.append(data)
      return { reply: {} }
    }
    const store = this.spools.get(id)
    if (store === undefined) throw new Error('shuf: missing spool')
    if (request.op === 'read')
      return { reply: {}, data: await store.read(Number(request.offset), Number(request.size)) }
    if (request.op === 'swap') {
      const left = Number(request.left) * 16
      const right = Number(request.right) * 16
      const first = await store.read(left, 16)
      const second = await store.read(right, 16)
      await store.write(left, second)
      await store.write(right, first)
      return { reply: {} }
    }
    throw new Error(`shuf: unknown request ${JSON.stringify(request.op)}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    for (const close of [
      () => closeStream(this.stream),
      () => this.errors.close(),
      ...[...this.spools.values()].map((spool) => () => spool.close()),
    ]) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    this.spools.clear()
    if (failures.length > 0) {
      for (const error of failures.slice(1)) console.debug('shuf cleanup failed:', error)
      throw failures[0]
    }
  }
}

async function engine(
  ids: IdSource,
  config: Readonly<Record<string, util.JSONType>>,
  spools = new Map<number, ByteSpool>(),
  signal?: AbortSignal,
): Promise<ByteSource> {
  const stream = await openStream('shuf', config)
  const host = new ShufHost(ids, stream, spools)
  return rechunk(
    new OutputStream(serveRequests(stream, host, signal), () => host.close()),
    CHUNK_SIZE,
  )
}

async function sampleRecords(
  ids: IdSource,
  sources: ByteSource[],
  sep: string,
  count: bigint | null,
  repeat: boolean,
  signal?: AbortSignal,
): Promise<ByteSource> {
  const separator = sep.charCodeAt(0)
  const data = new ByteSpool()
  try {
    for (const source of sources) {
      await data.fill(chunks(source, signal))
      if (data.size > 0 && (await data.read(data.size - 1, 1))[0] !== separator)
        await data.append(Uint8Array.of(separator))
    }
    let counted = ''
    for await (const chunk of runStream(
      'shuf',
      { mode: 'count', separator },
      data.stream(),
      signal,
    ))
      counted += new TextDecoder().decode(chunk)
    const available = Number(counted)
    const need = emitCount(BigInt(available), count, repeat)
    if (need > MAX_OUTPUT_LINES) throw new Error(MEMORY_EXHAUSTED)
    return await engine(
      ids,
      { mode: 'records', separator, size: data.size, available, need: Number(need), repeat },
      new Map([[0, data]]),
      signal,
    )
  } catch (error) {
    await data.close()
    throw error
  }
}

async function sampleItems(
  ids: IdSource,
  items: string[],
  count: bigint | null,
  repeat: boolean,
  separator: number,
  signal?: AbortSignal,
): Promise<ByteSource> {
  const need = emitCount(BigInt(items.length), count, repeat)
  if (need > MAX_OUTPUT_LINES) throw new Error(MEMORY_EXHAUSTED)
  const data = new ByteSpool()
  const index = new ByteSpool()
  try {
    const budget = new YieldBudget(signal)
    for (const item of items) {
      await budget.run()
      const raw = ENC.encode(item)
      const entry = new Uint8Array(16)
      const view = new DataView(entry.buffer)
      view.setBigUint64(0, BigInt(data.size), true)
      view.setBigUint64(8, BigInt(raw.length), true)
      await index.append(entry)
      await data.append(raw)
    }
    return await engine(
      ids,
      {
        mode: 'indexed',
        separator,
        size: data.size,
        available: items.length,
        need: Number(need),
        repeat,
      },
      new Map([
        [0, data],
        [1, index],
      ]),
      signal,
    )
  } catch (error) {
    await data.close()
    await index.close()
    throw error
  }
}

export async function shufGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
  parsed: ShufFlags | IOResult = parseFlags(ctx.flags),
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const ids = ctx.ids ?? new SystemIdSource()
  if (parsed instanceof IOResult) return [null, parsed]
  const { count: nFlag, inputRange, echo: echoMode, zeroTerminated: zeroSep } = parsed
  const repeat = parsed.withReplacement
  const output =
    parsed.output === null
      ? null
      : new PathSpec({
          virtual: parsed.output.virtual,
          directory: parsed.output.virtual,
          vfsPath: stripSlash(parsed.output.virtual),
          resolved: true,
          rawPath: parsed.output.rawPath,
        })
  const sep = zeroSep ? '\x00' : '\n'

  let items: string[] = []
  // `-i` never fills `items`: it samples straight into the output, because the
  // range it names can hold 2**64 values (SH5).
  let result: ByteSource | null = null
  if (inputRange !== null) {
    const extra = paths[0]
    if (extra !== undefined) {
      // GNU: -i names the input, so a file operand is one too many.
      const word = extra.rawPath !== '' ? extra.rawPath : extra.virtual
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: extra operand '${quoteText(word)}'${TRY_HELP}\n`),
        }),
      ]
    }
    const [low, high] = inputRange
    const need = emitCount(high - low + 1n, nFlag, repeat)
    if (need > MAX_OUTPUT_LINES) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
    result = await engine(
      ids,
      {
        mode: 'range',
        separator: sep.charCodeAt(0),
        low: String(low),
        high: String(high),
        need: Number(need),
        repeat,
      },
      undefined,
      ctx.signal,
    )
  } else if (echoMode) {
    // An operand -e echoes is named below the mount the command runs on.
    const root = mountRoot(ctx)
    items = paths.length > 0 ? paths.map((p) => `/${mountKey(p.virtual, root)}`) : [...texts]
  } else {
    try {
      result = await sampleRecords(
        ids,
        paths.length > 0 ? paths.map((p) => stream(p)) : [ctx.stdin ?? new Uint8Array()],
        sep,
        nFlag,
        repeat,
        ctx.signal,
      )
    } catch (error) {
      if (!(error instanceof Error) || error.message !== MEMORY_EXHAUSTED) throw error
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
  }
  if (result === null) {
    const need = emitCount(BigInt(items.length), nFlag, repeat)
    if (need > MAX_OUTPUT_LINES) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
    result = await sampleItems(ids, items, nFlag, repeat, sep.charCodeAt(0), ctx.signal)
  }
  if (output !== null) {
    try {
      await write(output, result)
    } catch (err) {
      if (!isFsError(err)) throw err
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: ${output.rawPath}: ${String(fsStrerror(err))}\n`),
        }),
      ]
    } finally {
      await closeQuietly(result)
    }
    return [null, new IOResult()]
  }
  return [result, new IOResult()]
}

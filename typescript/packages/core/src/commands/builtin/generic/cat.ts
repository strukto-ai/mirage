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

import { stdinStream, stdinStat } from '../utils/stream.ts'
import { concat } from '../../../utils/bytes.ts'
import { asyncChain, ensureStream } from '../../../io/stream.ts'
import { chunks } from '../../../io/cooperative.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, Limit, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { reportedStream, splitReadable } from '../utils/operands.ts'
import { resolveSource } from '../utils/stream.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { CHAR_DEVICE_MAX_BYTES } from '../utils/constants.ts'
import { deadlineCheck, truncateStream } from '../utils/limit.ts'
import { encodeText } from '../../../shell/bytes.ts'

const NL = 0x0a

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function formatLineNo(n: number): string {
  return String(n).padStart(6, ' ')
}

interface CatFlags {
  readonly numberLines: boolean
  readonly numberNonblank: boolean
  readonly showEnds: boolean
  readonly showTabs: boolean
  readonly showNonprinting: boolean
  readonly squeezeBlank: boolean
}

function parseFlags(bag: Record<string, FlagValue>): CatFlags {
  const fl = new FlagView(bag, specOf('cat'))
  const showAll = fl.asBool('show_all')
  return {
    numberLines: fl.asBool('number'),
    numberNonblank: fl.asBool('number_nonblank'),
    showEnds: fl.asBool('show_ends') || fl.asBool('e') || showAll,
    showTabs: fl.asBool('show_tabs') || fl.asBool('t') || showAll,
    showNonprinting: fl.asBool('show_nonprinting') || fl.asBool('e') || fl.asBool('t') || showAll,
    squeezeBlank: fl.asBool('squeeze_blank'),
  }
}

// Render a line GNU cat -T / -v style: tabs become ^I under -T; under -v
// control bytes become ^X, DEL becomes ^?, and high bytes get the M- prefix
// with the same rules applied to the low seven bits.
function visible(
  line: Uint8Array,
  showTabs: boolean,
  showNonprinting: boolean,
): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  for (const byte of line) {
    if (byte === 9) {
      if (showTabs) out.push(94, 73)
      else out.push(byte)
    } else if (!showNonprinting) {
      out.push(byte)
    } else if (byte < 32) {
      out.push(94, byte + 64)
    } else if (byte === 127) {
      out.push(94, 63)
    } else if (byte >= 128) {
      out.push(77, 45)
      const low = byte - 128
      if (low < 32) out.push(94, low + 64)
      else if (low === 127) out.push(94, 63)
      else out.push(low)
    } else {
      out.push(byte)
    }
  }
  return Uint8Array.from(out)
}

/**
 * Line-process a stream for GNU cat's display flags (-n -E -T -v -s), one
 * write per line, as Python's. cat takes its input whole and may be called
 * outside the factory's guard, so each pull races the abort, and every pull
 * and every 64 lines check `overdue` (the invocation's deadline) and yield to
 * timers: -s can squeeze a whole RAM read, and a ready input need never end a
 * line, without writing anything. A line split across chunks is joined once
 * it ends.
 */
async function* displayLines(
  source: AsyncIterable<Uint8Array>,
  display: CatFlags,
  signal?: AbortSignal,
  overdue?: () => void,
): AsyncIterable<Uint8Array> {
  let lineNo = 0
  let scanned = 0
  let pending: Uint8Array[] = []
  let prevBlank = false
  const budget = new YieldBudget(signal, overdue)
  const transform = display.showTabs || display.showNonprinting
  const suffix = encodeText(display.showEnds ? '$\n' : '\n')
  for await (const chunk of chunks(source, signal, false, overdue)) {
    let start = 0
    let nl = chunk.indexOf(NL)
    while (nl >= 0) {
      const tail = chunk.subarray(start, nl)
      let line = pending.length === 0 ? tail : concat([...pending, tail])
      pending = []
      start = nl + 1
      nl = chunk.indexOf(NL, start)
      if (++scanned % 64 === 0) {
        const paused = budget.run()
        if (paused !== undefined) await paused
      }
      if (display.squeezeBlank && line.byteLength === 0 && prevBlank) {
        prevBlank = true
        continue
      }
      prevBlank = line.byteLength === 0
      const shouldNumber =
        (!display.numberNonblank && display.numberLines) ||
        (display.numberNonblank && line.byteLength > 0)
      if (shouldNumber) lineNo += 1
      if (transform) line = visible(line, display.showTabs, display.showNonprinting)
      yield concat(
        shouldNumber ? [encodeText(`${formatLineNo(lineNo)}\t`), line, suffix] : [line, suffix],
      )
    }
    if (start < chunk.byteLength) pending.push(chunk.subarray(start))
  }
  if (pending.length > 0) {
    const buf = concat(pending)
    const shouldNumber = display.numberLines || display.numberNonblank
    if (shouldNumber) lineNo += 1
    const last = transform ? visible(buf, display.showTabs, display.showNonprinting) : buf
    yield shouldNumber ? concat([encodeText(`${formatLineNo(lineNo)}\t`), last]) : last
  }
}

export async function catGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  stream: Stream,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  stream = stdinStream(stream, opts.stdin)
  const display = parseFlags(opts.flags)
  const wantsDisplay = Object.values(display).some(Boolean)
  if (paths.length > 0) {
    const stats = new Map<string, FileStat>()
    const rememberStat = async (p: PathSpec): Promise<FileStat> => {
      const row = await stat(p)
      stats.set(p.virtual, row)
      return row
    }
    const [readable, err] = await splitReadable(paths, rememberStat, 'cat')
    const errBytes = err === '' ? null : encodeText(err)
    if (readable.length === 0) {
      return [null, new IOResult({ exitCode: err === '' ? 0 : 1, stderr: errBytes })]
    }
    const outputs: AsyncIterable<Uint8Array>[] = []
    const io = new IOResult({ exitCode: err === '' ? 0 : 1, stderr: errBytes })
    for (const p of readable) {
      let source: ByteSource = stream(p)
      if (stats.get(p.virtual)?.type === FileType.CHAR_DEVICE) {
        source = truncateStream(source, io, new Limit({ maxBytes: CHAR_DEVICE_MAX_BYTES }))
      }
      const out = ensureStream(source)
      outputs.push(readable.length === 1 ? out : reportedStream(out, io, p, 'cat'))
    }
    const merged = outputs.length === 1 ? outputs[0] : asyncChain(outputs)
    if (merged === undefined) throw new Error('cat: missing readable stream')
    const out: ByteSource = wantsDisplay
      ? displayLines(merged, display, opts.signal, deadlineCheck(opts))
      : merged
    return [out, io]
  }
  try {
    const source = resolveSource(opts.stdin)
    const out: ByteSource = wantsDisplay
      ? displayLines(source, display, opts.signal, deadlineCheck(opts))
      : source
    return [out, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(`${msg}\n`) })]
  }
}

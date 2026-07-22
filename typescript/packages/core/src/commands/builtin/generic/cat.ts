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

import { CachableAsyncIterator } from '../../../io/cachable_iterator.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { splitReadable } from '../utils/operands.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const NL = 0x0a

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function formatLineNo(n: number): string {
  return String(n).padStart(6, ' ')
}

/**
 * Number lines like GNU `cat -n`: a 6-wide right-justified count followed by a
 * tab, then the line. A final line with no trailing newline keeps its missing
 * newline (no spurious `\n` is appended).
 */
export async function* numberLines(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let lineNo = 0
  let buf = new Uint8Array(0)
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue
    const merged = new Uint8Array(buf.byteLength + chunk.byteLength)
    merged.set(buf, 0)
    merged.set(chunk, buf.byteLength)
    buf = merged
    let nl = buf.indexOf(NL)
    while (nl >= 0) {
      lineNo += 1
      yield ENC.encode(`${formatLineNo(lineNo)}\t`)
      yield buf.subarray(0, nl + 1)
      buf = buf.subarray(nl + 1)
      nl = buf.indexOf(NL)
    }
  }
  if (buf.byteLength > 0) {
    lineNo += 1
    yield ENC.encode(`${formatLineNo(lineNo)}\t`)
    yield buf
  }
}

async function* chainStreams(
  streams: readonly AsyncIterable<Uint8Array>[],
): AsyncIterable<Uint8Array> {
  for (const s of streams) {
    for await (const chunk of s) yield chunk
  }
}

interface CatDisplay {
  numberLines: boolean
  numberNonblank: boolean
  showEnds: boolean
  showTabs: boolean
  showNonprinting: boolean
  squeezeBlank: boolean
}

function parseFlags(flags: Record<string, string | boolean | string[]>): CatDisplay {
  const showAll = flags.A === true || flags.show_all === true
  return {
    numberLines: flags.n === true || flags.number === true,
    numberNonblank: flags.b === true || flags.number_nonblank === true,
    showEnds: flags.E === true || flags.show_ends === true || flags.e === true || showAll,
    showTabs: flags.T === true || flags.show_tabs === true || flags.t === true || showAll,
    showNonprinting:
      flags.v === true ||
      flags.show_nonprinting === true ||
      flags.e === true ||
      flags.t === true ||
      showAll,
    squeezeBlank: flags.s === true || flags.squeeze_blank === true,
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

/** Line-process a stream for GNU cat's display flags (-n -E -T -v -s). */
async function* displayLines(
  source: AsyncIterable<Uint8Array>,
  display: CatDisplay,
): AsyncIterable<Uint8Array> {
  let lineNo = 0
  let buf = new Uint8Array(0)
  let prevBlank = false
  const transform = display.showTabs || display.showNonprinting
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue
    const mergedBuf = new Uint8Array(buf.byteLength + chunk.byteLength)
    mergedBuf.set(buf, 0)
    mergedBuf.set(chunk, buf.byteLength)
    buf = mergedBuf
    let nl = buf.indexOf(NL)
    while (nl >= 0) {
      let line = buf.subarray(0, nl)
      buf = buf.subarray(nl + 1)
      nl = buf.indexOf(NL)
      if (display.squeezeBlank && line.byteLength === 0 && prevBlank) {
        prevBlank = true
        continue
      }
      prevBlank = line.byteLength === 0
      const shouldNumber =
        (!display.numberNonblank && display.numberLines) ||
        (display.numberNonblank && line.byteLength > 0)
      if (shouldNumber) lineNo += 1
      if (shouldNumber) yield ENC.encode(`${formatLineNo(lineNo)}\t`)
      if (transform) line = visible(line, display.showTabs, display.showNonprinting)
      yield line
      yield ENC.encode(display.showEnds ? '$\n' : '\n')
    }
  }
  if (buf.byteLength > 0) {
    const shouldNumber = display.numberLines || display.numberNonblank
    if (shouldNumber) lineNo += 1
    if (shouldNumber) yield ENC.encode(`${formatLineNo(lineNo)}\t`)
    yield transform ? visible(buf, display.showTabs, display.showNonprinting) : buf
  }
}

export async function catGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  stream: Stream,
): Promise<CommandFnResult> {
  const display = parseFlags(opts.flags)
  if (display.numberNonblank) display.numberLines = false
  const wantsDisplay = Object.values(display).some(Boolean)
  if (paths.length > 0) {
    const [readable, err] = await splitReadable(paths, stat, 'cat')
    const errBytes = err === '' ? null : ENC.encode(err)
    if (readable.length === 0) {
      return [null, new IOResult({ exitCode: err === '' ? 0 : 1, stderr: errBytes })]
    }
    const reads: Record<string, ByteSource> = {}
    const cacheKeys: string[] = []
    const outputs: AsyncIterable<Uint8Array>[] = []
    for (const p of readable) {
      const cachable = new CachableAsyncIterator(stream(p))
      reads[p.mountPath] = cachable
      cacheKeys.push(p.mountPath)
      outputs.push(cachable)
    }
    const merged = outputs.length === 1 ? outputs[0] : chainStreams(outputs)
    if (merged === undefined) throw new Error('cat: missing readable stream')
    const out: ByteSource = wantsDisplay ? displayLines(merged, display) : merged
    return [
      out,
      new IOResult({ reads, cache: cacheKeys, exitCode: err === '' ? 0 : 1, stderr: errBytes }),
    ]
  }
  try {
    const source = resolveSource(opts.stdin, 'cat: missing operand')
    const out: ByteSource = wantsDisplay ? displayLines(source, display) : source
    return [out, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}

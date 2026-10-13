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

import { operandLabel } from '../utils/stream.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { IOResult } from '../../../io/types.ts'
import { FileType, Limit, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { numberFlagError, parseByteCount } from '../tail_counts.ts'
import { CHAR_DEVICE_MAX_BYTES, STDIN_HEADER_NAME } from '../utils/constants.ts'
import { asyncChain } from '../../../io/stream.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { truncateStream } from '../utils/limit.ts'
import { splitOpened } from '../utils/operands.ts'
import { resolveSource } from '../utils/stream.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'

const NL = 0x0a

interface HeadFlags {
  lines: number
  bytesMode: number | null
  quiet: boolean
  verbose: boolean
  zeroTerminated: boolean
}

function parseFlags(bag: Record<string, FlagValue>): HeadFlags | string {
  const fl = new FlagView(bag, specOf('head'))
  const nRaw = fl.asStr('lines') ?? null
  const cRaw = fl.asStr('bytes') ?? null
  const numErr = numberFlagError('head', nRaw, cRaw)
  if (numErr !== null) return numErr
  // The last of -q and -v decides, as in GNU head.
  const headers = fl.typedOrder('quiet', 'silent', 'verbose').at(-1)
  return {
    lines: nRaw !== null ? Number.parseInt(nRaw, 10) : 10,
    bytesMode: cRaw !== null ? parseByteCount(cRaw) : null,
    quiet: headers === 'quiet' || headers === 'silent',
    verbose: headers === 'verbose',
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

/**
 * Emit the head of a stream like GNU `head`.
 *
 * Bytes (`bytesMode`): positive = first N bytes, negative = all but the last N
 * bytes, 0 = nothing. Lines (`lines`): positive = first N lines, negative = all
 * but the last N lines, 0 = nothing. A final line without a trailing newline is
 * preserved as-is (no newline is appended). head takes its input whole and
 * writes the producer's chunks on, so a line count yields to timers and the
 * abort every 64 lines, and a held line split across chunks is joined once.
 */
async function* headStream(
  source: AsyncIterable<Uint8Array>,
  lines: number,
  bytesMode: number | null,
  zeroTerminated = false,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (bytesMode !== null) {
    if (bytesMode === 0) return
    if (bytesMode > 0) {
      let remaining = bytesMode
      for await (const chunk of source) {
        if (chunk.byteLength >= remaining) {
          if (remaining > 0) yield chunk.subarray(0, remaining)
          return
        }
        yield chunk
        remaining -= chunk.byteLength
      }
      return
    }
    const keep = -bytesMode
    let buf: Uint8Array = new Uint8Array(0)
    for await (const chunk of source) {
      buf = concat([buf, chunk])
      if (buf.byteLength > keep) {
        yield buf.subarray(0, buf.byteLength - keep)
        buf = buf.subarray(buf.byteLength - keep)
      }
    }
    return
  }

  const delimiter = zeroTerminated ? 0 : NL
  const budget = new YieldBudget(signal)
  if (lines >= 0) {
    if (lines === 0) return
    let emitted = 0
    for await (const chunk of source) {
      let start = 0
      while (emitted < lines) {
        const nl = chunk.indexOf(delimiter, start)
        if (nl < 0) {
          if (start < chunk.byteLength) yield chunk.subarray(start)
          break
        }
        yield chunk.subarray(start, nl + 1)
        emitted += 1
        if (emitted >= lines) return
        start = nl + 1
        if (emitted % 64 === 0) {
          const paused = budget.run()
          if (paused !== undefined) await paused
        }
      }
    }
    return
  }

  const keep = -lines
  const recent: Uint8Array[] = []
  let scanned = 0
  let pending: Uint8Array[] = []
  for await (const chunk of source) {
    let start = 0
    let nl = chunk.indexOf(delimiter)
    while (nl >= 0) {
      const tail = chunk.subarray(start, nl + 1)
      recent.push(pending.length === 0 ? tail : concat([...pending, tail]))
      pending = []
      start = nl + 1
      nl = chunk.indexOf(delimiter, start)
      if (recent.length > keep) {
        const out = recent.shift()
        if (out !== undefined) yield out
      }
      if (++scanned % 64 === 0) {
        const paused = budget.run()
        if (paused !== undefined) await paused
      }
    }
    if (start < chunk.byteLength) pending.push(chunk.subarray(start))
  }
  if (pending.length > 0) {
    recent.push(concat(pending))
    if (recent.length > keep) {
      const out = recent.shift()
      if (out !== undefined) yield out
    }
  }
}

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

async function* headMulti(
  stream: Stream,
  paths: readonly PathSpec[],
  lines: number,
  bytesMode: number | null,
  showHeaders: boolean,
  zeroTerminated: boolean,
  unread: ReadonlySet<string>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]
    if (p === undefined) continue
    if (showHeaders) {
      const prefix = i > 0 ? '\n' : ''
      yield encodeText(`${prefix}==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`)
    }
    // A directory opened: its header prints and its read fails.
    if (unread.has(p.virtual)) continue
    const source = stream(p)
    yield* headStream(source, lines, bytesMode, zeroTerminated, signal)
  }
}

export async function headGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  stream: Stream,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  }
  if (paths.length > 0) {
    const showHeaders = (parsed.verbose || paths.length > 1) && !parsed.quiet
    const [opened, unread, err] = await splitOpened(paths, stat, 'head')
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : encodeText(err),
    })
    if (opened.length === 0) return [null, io]
    const sourceFor = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      const source = stream(p)
      if ((await stat(p)).type === FileType.CHAR_DEVICE && parsed.bytesMode === null) {
        yield* truncateStream(source, io, new Limit({ maxBytes: CHAR_DEVICE_MAX_BYTES }))
        return
      }
      yield* source
    }
    return [
      headMulti(
        sourceFor,
        opened,
        parsed.lines,
        parsed.bytesMode,
        showHeaders,
        parsed.zeroTerminated,
        unread,
        opts.signal,
      ),
      io,
    ]
  }
  try {
    const source = resolveSource(opts.stdin)
    const body = headStream(
      source,
      parsed.lines,
      parsed.bytesMode,
      parsed.zeroTerminated,
      opts.signal,
    )
    // -v heads a stdin nobody named with the name it gives `-`.
    const header = encodeText(`==> ${STDIN_HEADER_NAME} <==\n`)
    return [parsed.verbose && !parsed.quiet ? asyncChain([header, body]) : body, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(`${msg}\n`) })]
  }
}

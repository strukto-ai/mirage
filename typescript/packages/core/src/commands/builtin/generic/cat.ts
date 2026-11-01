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
import { asyncChain, ensureStream } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  FileType,
  Limit,
  type FileStat,
  type PathSpec,
  type StatFn,
  type ReadStreamFn,
} from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { reportedStream, splitReadable } from '../utils/operands.ts'
import { resolveSource, streamOutput } from '../utils/stream.ts'
import { openStream } from '../../../rs/stream.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { CHAR_DEVICE_MAX_BYTES } from '../utils/constants.ts'
import { truncateStream } from '../utils/limit.ts'
import { encodeText } from '../../../shell/bytes.ts'

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

async function displayLines(
  source: AsyncIterable<Uint8Array>,
  display: CatFlags,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  return streamOutput(
    await openStream('cat', {
      number_lines: display.numberLines,
      number_nonblank: display.numberNonblank,
      show_ends: display.showEnds,
      show_tabs: display.showTabs,
      show_nonprinting: display.showNonprinting,
      squeeze_blank: display.squeezeBlank,
    }),
    source,
    signal,
  )
}

export async function catGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: StatFn,
  stream: ReadStreamFn,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  stream = stdinStream(stream, ctx.stdin)
  const display = parseFlags(ctx.flags)
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
    const out: ByteSource = wantsDisplay ? await displayLines(merged, display, ctx.signal) : merged
    return [out, io]
  }
  const source = resolveSource(ctx.stdin)
  const out: ByteSource = wantsDisplay ? await displayLines(source, display, ctx.signal) : source
  return [out, new IOResult()]
}

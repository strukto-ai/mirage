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

import type { CommandFn, Context } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStat, dirAwareStream, resolveOrEmpty } from '../files.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { helpPage } from '../../../spec/standard.ts'
import { isEisdir, isEnoent, isFsError } from '../../../../errors/fs.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import { closeStream, openStream, runStream } from '../../../../rs/stream.ts'
import { byteView, encodeText, fromByteView } from '../../../../shell/bytes.ts'
import { type FileStat, FileType, type JsonValue, type PathSpec } from '../../../../types.ts'
import { shellQuoteAlways } from '../../../../utils/quote.ts'
import { stdinStat, stdinStream } from '../../utils/stream.ts'
import { perOperand } from '../../utils/operands.ts'

/**
 * mirage's strings usage, from its `Usage:` line on, which binutils prints for
 * an encoding or a radix it cannot read. Mirrors Python's `_usage_block`.
 */
function usageBlock(): string {
  const page = helpPage('strings', specOf('strings'))
  return page.slice(page.indexOf('Usage: '))
}

/**
 * The engine's configuration, or null for an encoding or a radix binutils
 * refuses. Mirrors Python's `_config`.
 */
function engineConfig(fl: FlagView): Record<string, JsonValue> | null {
  const encoding = fl.asStr('encoding') ?? null
  const radix = fl.typedOrder('radix', 'o').at(-1) === 'o' ? 'o' : (fl.asStr('radix') ?? null)
  if (encoding !== null && (encoding.length !== 1 || !'sSblBL'.includes(encoding))) return null
  if (radix !== null && (radix.length !== 1 || !'odx'.includes(radix))) return null
  const minLen = fl.asText('bytes')
  const separator = fl.asText('output_separator')
  return {
    min_len: minLen === undefined ? null : byteView(minLen),
    encoding,
    radix,
    whitespace: fl.asBool('include_all_whitespace'),
    separator: separator === undefined ? null : byteView(separator),
  }
}

/**
 * The operands strings reads, and its lines for the rest, worded as binutils
 * words them: a missing file is `No such file` and a directory is a warning.
 * Mirrors Python's `_readable`.
 */
async function readable(
  paths: readonly PathSpec[],
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<[PathSpec[], string]> {
  const found: PathSpec[] = []
  let err = ''
  for (const path of paths) {
    const shown = shellQuoteAlways(path.rawPath)
    let entry: FileStat
    try {
      entry = await stat(path)
    } catch (e) {
      if (!isFsError(e)) throw e
      if (isEnoent(e)) err += `strings: ${shown}: No such file\n`
      else if (isEisdir(e)) err += `strings: Warning: ${shown} is a directory\n`
      else err += fsErrorLine('strings', path, e)
      continue
    }
    if (entry.type === FileType.DIRECTORY) {
      err += `strings: Warning: ${shown} is a directory\n`
      continue
    }
    found.push(path)
  }
  return [found, err]
}

const strings: CommandFn = async (_accessor, paths, _texts, ctx: Context) => {
  const fl = new FlagView(ctx.flags, specOf('strings'))
  const config = engineConfig(fl)
  if (config === null) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(usageBlock()) })]
  }
  // The engine refuses -n before any operand is touched, as binutils does.
  try {
    await closeStream(await openStream('strings', config))
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, new IOResult({ exitCode: 1, stderr: fromByteView(`${err.message}\n`) })]
  }
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  // binutils strings never reads `-` as stdin; only /dev/stdin is.
  const [found, err] = await readable(resolved, stdinStat(dirAwareStat(files, ctx), false))
  if (err !== '' && found.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(err) })]
  }
  const stream = stdinStream(dirAwareStream(files, ctx), ctx.stdin, false, false)
  const io = new IOResult(err === '' ? {} : { exitCode: 1, stderr: encodeText(err) })
  const names = (found.length > 0 ? found.map((p) => p.rawPath) : ['{standard input}'])[
    Symbol.iterator
  ]()
  const named = fl.asBool('print_file_name')
  const each = (source: ByteSource): AsyncIterable<Uint8Array> => {
    const name = names.next().value ?? ''
    const prefix = named ? byteView(encodeText(`${name}: `)) : null
    return runStream('strings', { ...config, prefix }, source, ctx.signal)
  }
  return [perOperand(found, stream, ctx.stdin, io, 'strings', each), io]
}

export const BUILDER: GenericCommand = {
  name: 'strings',
  read: true,
  fn: strings,
}

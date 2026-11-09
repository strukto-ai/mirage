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

import { fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { PathSpec, ReadStreamFn } from '../../../types.ts'
import { GzipDataError, gunzipStream } from '../../../utils/compress.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { formatRecords } from '../utils/output.ts'
import { resolveSource, stdinStream } from '../utils/stream.ts'
import { gzipSuffix } from './decompress.ts'

const GZIP_SUFFIX = '.gz'
const LESS_FAMILY: ReadonlySet<string> = new Set(['less', 'zless'])
const ZIPPED: ReadonlySet<string> = new Set(['zless', 'zmore'])

function header(name: string): Uint8Array {
  return encodeText(`::::::::::::::\n${name}\n::::::::::::::\n`)
}

function gzipName(name: string): string {
  return gzipSuffix(name, GZIP_SUFFIX) !== null ? name : name + GZIP_SUFFIX
}

/** `source` read up to its first chunk, so a failed open throws here. */
async function opened(source: AsyncIterable<Uint8Array>): Promise<AsyncGenerator<Uint8Array>> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  async function* resumed(): AsyncGenerator<Uint8Array> {
    try {
      if (first.done === true) return
      yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        yield next.value
      }
    } finally {
      await iterator.return?.()
    }
  }
  return resumed()
}

/** The operands one after another, with what each program says of one it
 * cannot open. With no terminal to page on, `less` shows a name only the
 * first time it is given, and `more` heads each file with its name; `zmore`
 * does only for several. */
async function* pages(
  paths: readonly PathSpec[],
  read: ReadStreamFn,
  stdin: ByteSource | null,
  command: string,
  io: IOResult,
): AsyncGenerator<Uint8Array> {
  const zipped = ZIPPED.has(command)
  const lines: string[] = []
  const complain = (line: string): void => {
    lines.push(line)
    io.stderr = formatRecords(lines)
  }
  if (paths.length === 0) {
    const source = resolveSource(stdin)
    yield* zipped ? gunzipStream(source, false, true) : source
    return
  }
  const sourceOf = stdinStream(read, stdin, false, command !== 'more')
  const headed = command === 'more' || (command === 'zmore' && paths.length > 1)
  const seen = new Set<string>()
  for (const path of paths) {
    const name = path.rawPath
    if (LESS_FAMILY.has(command)) {
      if (seen.has(path.virtual)) continue
      seen.add(path.virtual)
    }
    if (command === 'zmore' && headed) yield header(name)
    let body: AsyncGenerator<Uint8Array>
    try {
      body = await opened(sourceOf(path))
    } catch (error) {
      if (isEisdir(error)) {
        if (command === 'more') yield encodeText(`\n*** ${name}: directory ***\n\n`)
        if (!LESS_FAMILY.has(command)) continue
        yield encodeText(`${name} is a directory\n`)
        continue
      }
      if (!isFsError(error)) throw error
      const why = String(fsStrerror(error))
      if (command === 'more') {
        complain(`more: cannot open ${name}: ${why}`)
        continue
      }
      if (command === 'zmore') {
        yield encodeText(`gzip: ${gzipName(name)}: ${why}\n`)
        continue
      }
      if (zipped) complain(`gzip: ${gzipName(name)}: ${why}`)
      yield encodeText(`${name}: ${why}\n`)
      continue
    }
    if (command === 'more') yield header(name)
    try {
      yield* zipped ? gunzipStream(body, false, true) : body
    } catch (error) {
      if (!(error instanceof GzipDataError)) throw error
      complain(error.render(name).replace(/\n$/, ''))
    } finally {
      await closeQuietly(body)
    }
  }
}

/** Run a pager with nothing to page on, as these exit 0 whatever the files
 * were. Pinned against less 668, util-linux 2.41.5 and gzip 1.13. */
export function pagerGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: ReadStreamFn,
  command: string,
): CommandFnResult {
  const io = new IOResult()
  return [pages(paths, read, ctx.stdin, command, io), io]
}

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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { closeStream, mergeOutput, openStream } from '../../../rs/stream.ts'
import { concat } from '../../../utils/bytes.ts'
import { byteView, encodeText, fromByteView } from '../../../shell/bytes.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { neverOpened, stdinStream } from '../utils/stream.ts'

const NEWLINE = new Uint8Array([0x0a])

/**
 * Convert each operand in order through mirage-rs's iconv, as glibc 2.41
 * converts. An input that cannot be opened is reported and skipped; one that
 * opens and then refuses the read, a directory, ends the run. Mirrors
 * Python's `iconv_generic`.
 */
export async function iconvGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('iconv'))
  if (fl.asBool('list')) {
    const list = await openStream('iconv', { list: true })
    try {
      return [list.finish(), new IOResult()]
    } finally {
      list.close()
    }
  }
  let engine
  try {
    engine = await openStream('iconv', {
      from: byteView(fl.asStr('from_code', '')),
      to: byteView(fl.asStr('to_code', '')),
      omit: fl.asBool('c'),
      inputs: Math.max(paths.length, 1),
    })
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, new IOResult({ exitCode: 1, stderr: concat([fromByteView(err.message), NEWLINE]) })]
  }
  const converter = engine
  const read = stdinStream(stream, ctx.stdin)
  const operands =
    paths.length > 0
      ? paths.map((path) => ({ path, reader: new AsyncLineIterator(read(path)) }))
      : [{ path: null, reader: new AsyncLineIterator(ctx.stdin ?? new Uint8Array()) }]
  const io = new IOResult()
  const report = async (line: Uint8Array): Promise<void> => {
    if (line.byteLength === 0) return
    io.exitCode = 1
    io.stderr = concat([await materialize(io.stderr), line])
  }
  const readInput = async (index: number): Promise<Uint8Array | null> => {
    await report(converter.takeStderr())
    const operand = operands[index]
    if (operand === undefined) return null
    const { path, reader } = operand
    try {
      return await reader.readChunk()
    } catch (err) {
      if (!isFsError(err)) throw err
      const code = (err as { code?: string }).code
      const strerror = String(fsStrerror(err))
      let line: string
      if (
        path === null ||
        (code !== undefined && READ_FAILURES.has(code)) ||
        !neverOpened(reader, path, err)
      ) {
        line = `error while reading the input: ${strerror}`
        converter.cancel()
      } else {
        line = `cannot open input file \`${path.rawPath}': ${strerror}`
      }
      await report(encodeText(`iconv: ${line}\n`))
      return null
    }
  }
  async function* output(): AsyncIterable<Uint8Array> {
    try {
      try {
        yield* mergeOutput(converter, readInput, ctx.signal)
      } catch (err) {
        if (!(err instanceof StreamRefusal)) throw err
        await report(concat([fromByteView(err.message), NEWLINE]))
        if (err.output.byteLength > 0) yield err.output
      }
      await report(converter.takeStderr())
      if (converter.status() !== 0) io.exitCode = 1
    } finally {
      for (const { reader } of operands) await reader.discard()
      await closeStream(converter)
    }
  }
  const converted = output()
  const outputPath = fl.asPath('output')
  if (outputPath !== undefined) {
    const spool = new ByteSpool()
    try {
      await spool.fill(converted)
      await write(outputPath, spool.stream())
    } finally {
      await spool.close()
    }
    return [null, io]
  }
  return [converted, io]
}

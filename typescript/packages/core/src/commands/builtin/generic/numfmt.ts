import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { openStream, streamOutputChunks, type OpenStream } from '../../../rs/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import type { JsonValue } from '../../../types.ts'

const ENC = new TextEncoder()

// A refusal stops the conversion after the records before it, exit 2.
async function* converted(
  stream: OpenStream,
  source: ByteSource,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  try {
    yield* streamOutputChunks(stream, source, signal)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    io.exitCode = 2
    io.stderr = ENC.encode(`${err.message}\n`)
    if (err.output.byteLength > 0) yield err.output
  }
}

// Every typed value of an option, a bare --header counting one record.
function typed(fl: FlagView, name: string): string[] {
  return fl.occurrences(name).map(([, value]) => byteView(value === true ? '1' : String(value)))
}

export async function numfmtGeneric(
  texts: readonly string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('numfmt'))
  const to = fl.asStr('to') ?? 'none'
  // mirage's one locale is C, whose thousands separator is empty, so
  // --grouping groups nothing; GNU still refuses it beside a --to scale.
  if (fl.asBool('grouping') && to !== 'none') {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('numfmt: grouping cannot be combined with --to\n'),
      }),
    ]
  }
  const config: Readonly<Record<string, JsonValue>> = {
    to,
    from: fl.asStr('from') ?? 'none',
    suffix: byteView(fl.asStr('suffix') ?? ''),
    operands: texts.map((text) => byteView(text)),
    fields: typed(fl, 'field'),
    delimiters: typed(fl, 'delimiter'),
    headers: typed(fl, 'header'),
    zero_terminated: fl.asBool('zero_terminated'),
  }
  let stream: OpenStream
  try {
    stream = await openStream('numfmt', config)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${err.message}\n`) })]
  }
  const io = new IOResult()
  const source = texts.length > 0 ? new Uint8Array(0) : (ctx.stdin ?? new Uint8Array(0))
  return [converted(stream, source, io, ctx.signal), io]
}

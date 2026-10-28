import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { closeStream, openStream, streamOutputChunks, type OpenStream } from '../../../rs/stream.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import type { JsonValue } from '../../../types.ts'

const ENC = new TextEncoder()

// A refusal stops the conversion after the records before it, exit 2.
async function* converted(
  stream: OpenStream,
  source: ByteSource,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  // The fields --invalid let through, said of and counted as each part
  // comes, while the stream is open: closing it releases them.
  const said: Uint8Array[] = []
  try {
    for await (const part of streamOutputChunks(stream, source, signal)) {
      said.push(stream.takeStderr())
      io.exitCode = stream.status()
      yield part
    }
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    io.exitCode = 2
    io.stderr = ENC.encode(`${err.message}\n`)
    if (err.output.byteLength > 0) yield err.output
    return
  }
  const warnings = concat(said)
  if (warnings.byteLength > 0) io.stderr = warnings
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
  const layout = fl.asStr('format')
  if (fl.asBool('grouping') && layout !== undefined) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('numfmt: --grouping cannot be combined with --format\n'),
      }),
    ]
  }
  const typedText = (text: string | undefined): string | null =>
    text === undefined ? null : byteView(text)
  const config: Readonly<Record<string, JsonValue>> = {
    to,
    from: fl.asStr('from') ?? 'none',
    suffix: byteView(fl.asStr('suffix') ?? ''),
    operands: texts.map((text) => byteView(text)),
    fields: typed(fl, 'field'),
    delimiters: typed(fl, 'delimiter'),
    headers: typed(fl, 'header'),
    zero_terminated: fl.asBool('zero_terminated'),
    from_unit: typedText(fl.asStr('from_unit')),
    to_unit: typedText(fl.asStr('to_unit')),
    round: fl.asStr('round') ?? 'from-zero',
    padding: typedText(fl.asStr('padding')),
    format: typedText(layout),
    invalid: fl.asStr('invalid') ?? 'abort',
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
  // Closing the output releases the stream and, unread, the records.
  let started = false
  async function* output(): AsyncGenerator<Uint8Array> {
    started = true
    yield* converted(stream, source, io, ctx.signal)
  }
  const producer = output()
  return [
    new OutputStream(producer, async () => {
      await closeStream(stream)
      if (!started) await closeQuietly(source)
    }),
    io,
  ]
}

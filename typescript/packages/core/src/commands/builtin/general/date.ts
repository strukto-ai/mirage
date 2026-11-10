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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { OutputStream, asyncChain, closeQuietly } from '../../../io/stream.ts'
import { resolveSource } from '../utils/stream.ts'
import {
  clockReply,
  dateReply,
  isoTimestamp,
  parseDateExprAsync,
  parsePosixTimeAsync,
} from '../../../utils/dates.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { openStreamSync } from '../../../rs/stream.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isFsError } from '../../../errors/fs.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { gnuStrftime, strftimeStream } from '../utils/strftime.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError, usageExitCode, usageHint } from '../../spec/usage.ts'
import { UsageError } from '../../errors.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { UTC_ZONE, zoneFromEnv, type Zone } from '../../../utils/timezone.ts'
import { systemDate } from '../../../utils/clock.ts'
import { byteView, encodeText } from '../../../shell/bytes.ts'

const ENC = new TextEncoder()

// GNU date's output formats, each chosen by one option: -I takes one
// per precision, --rfc-3339 one per its narrower set, -R the RFC 5322 line,
// and a line that chooses none gets the C locale's default (`%e`, so the 5th
// is " 5"). All of them render through strftime, the path `+FORMAT` takes.
const ISO_8601_FORMATS: Readonly<Record<string, string>> = {
  date: '%Y-%m-%d',
  hours: '%Y-%m-%dT%H%:z',
  minutes: '%Y-%m-%dT%H:%M%:z',
  seconds: '%Y-%m-%dT%H:%M:%S%:z',
  ns: '%Y-%m-%dT%H:%M:%S,%N%:z',
}
const RFC_3339_FORMATS: Readonly<Record<string, string>> = {
  date: '%Y-%m-%d',
  seconds: '%Y-%m-%d %H:%M:%S%:z',
  ns: '%Y-%m-%d %H:%M:%S.%N%:z',
}
const RFC_EMAIL_FORMAT = '%a, %d %b %Y %H:%M:%S %z'
const DEFAULT_FORMAT = '%a %b %e %H:%M:%S %Z %Y'
const MULTIPLE_FORMATS = 'date: multiple output formats specified\n'
// What setting the clock answers: mirage has none to set, which is what GNU
// says for a user without the privilege to.
const CANNOT_SET = 'date: cannot set date: Operation not permitted\n'

// The output formats the line's options choose, one per option. GNU keeps one
// and refuses a second as it reads it, so any two of -I, -R and --rfc-3339 are
// `multiple output formats specified`. The parser has already resolved a
// precision to its whole word (`-Is` is `seconds`). One divergence: the flag
// bag keeps the last of a REPEATED option, so `date -I -I` prints where GNU
// refuses it.
function optionFormats(fl: FlagView): string[] {
  const formats: string[] = []
  const iso = fl.raw('iso_8601')
  if (iso === true) formats.push(ISO_8601_FORMATS.date ?? '')
  else if (typeof iso === 'string') formats.push(ISO_8601_FORMATS[iso] ?? '')
  if (fl.asBool('rfc_email')) formats.push(RFC_EMAIL_FORMAT)
  const rfc3339 = fl.asStr('rfc_3339')
  if (rfc3339 !== undefined) formats.push(RFC_3339_FORMATS[rfc3339] ?? '')
  return formats
}

function multipleFormats(): CommandFnResult {
  return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(MULTIPLE_FORMATS) })]
}

// GNU's refusal of a date it cannot read, exit 1.
function invalidDate(text: string): CommandFnResult {
  return [
    null,
    new IOResult({ exitCode: 1, stderr: ENC.encode(`date: invalid date '${quoteText(text)}'\n`) }),
  ]
}

// GNU's refusal of a non-`+` operand beside `-d`, a usage error.
// GNU's refusal of two of -d, -f, -r and --resolution, a usage error.
function exclusiveError(): UsageError {
  return new UsageError(
    'date: the options to specify dates for printing are mutually exclusive\n' +
      usageHint(CommandName.DATE),
    usageExitCode(CommandName.DATE),
  )
}

// The moment one -d or -f expression names, or null; a blank expression names
// today at midnight, as GNU reads it. Mirrors Python's _named.
async function named(expression: string, zone: Zone, signal?: AbortSignal): Promise<Date | null> {
  if (expression.trim() === '') {
    const midnight = await parseDateExprAsync(
      gnuStrftime(systemDate(), '%Y-%m-%d', zone),
      zone,
      undefined,
      signal,
    )
    // Today's own ISO date always parses; the fallback is for the type.
    return midnight ?? systemDate()
  }
  return parseDateExprAsync(expression, zone, undefined, signal)
}

/**
 * `-f`'s output, a line at a time as the expressions arrive, read and printed
 * by one mirage-rs stream; what names no date goes to `io`'s stderr, exit 1.
 * Mirrors Python's `_dated`.
 */
async function* dated(
  first: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
  zone: Zone,
  fmt: string,
  io: IOResult,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const engine = openStreamSync('date_lines', { format: byteView(fmt) })
  const zones = new Map<string, Zone>()
  const budget = new YieldBudget(signal)
  let pending: Uint8Array | undefined = first
  try {
    for (;;) {
      while (engine.busy()) {
        await budget.run()
        const out = engine.drain()
        if (out.length > 0) yield out
      }
      const taken = engine.request()
      if (taken === null) break
      await budget.run()
      let out: Uint8Array
      if (taken[0].op === 'read') {
        let chunk = pending
        pending = undefined
        if (chunk === undefined) {
          const next = await rest.next()
          chunk = next.done === true ? undefined : next.value
        }
        out = engine.respond({ end: chunk === undefined }, chunk ?? new Uint8Array())
      } else if (taken[0].op === 'clock') {
        out = engine.respond({}, clockReply())
      } else {
        const [reply, data] = dateReply(taken[0], zone, zones)
        out = engine.respond(reply, data)
      }
      if (out.length > 0) yield out
    }
    const last = engine.finish()
    if (last.length > 0) yield last
    io.exitCode = engine.status()
    const errors = engine.takeStderr()
    if (errors.length > 0) io.stderr = errors
  } finally {
    engine.close()
  }
}

/**
 * `-f`: each line of the file a `-d` expression, printed in turn as it is
 * read. A line that names no date is reported and the next one still prints,
 * exit 1; `-` reads standard input. A file that cannot be opened is reported
 * before anything prints. Mirrors Python's `_each_line`.
 */
async function eachLine(
  ctx: Context,
  datefile: PathSpec,
  zone: Zone,
  fmt: string,
): Promise<CommandFnResult> {
  let source: AsyncIterator<Uint8Array>
  let first: Uint8Array
  try {
    if (datefile.rawPath === '-') source = resolveSource(ctx.stdin)[Symbol.asyncIterator]()
    else if (ctx.vfs !== undefined) {
      source = (await ctx.vfs.read(datefile, { stream: true }))[Symbol.asyncIterator]()
    } else throw Object.assign(new Error(datefile.rawPath), { code: 'ENOENT' })
    const step = await source.next()
    first = step.done === true ? new Uint8Array() : step.value
  } catch (err) {
    if (!isFsError(err)) throw err
    const line = fsErrorLine(CommandName.DATE, datefile, err)
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(line) })]
  }
  const io = new IOResult()
  // The output owns the input: closed early, or before its first pull, it
  // closes the reader too.
  const out = dated(first, source, zone, fmt, io, ctx.signal)
  return [new OutputStream(out, () => closeQuietly(source)), io]
}

/**
 * `-r`: the moment a file was last modified. A backend that reports no time
 * for it answers the epoch. Mirrors Python's `_modified`.
 */
async function modified(ctx: Context, reference: PathSpec): Promise<Date> {
  if (ctx.vfs === undefined) {
    throw Object.assign(new Error(reference.rawPath), { code: 'ENOENT' })
  }
  return new Date((isoTimestamp((await ctx.vfs.stat(reference)).modified) ?? 0) * 1000)
}

function lacksPlusError(operand: string): UsageError {
  return new UsageError(
    `date: the argument '${quoteText(operand)}' lacks a leading '+';\n` +
      'when using an option to specify date(s), any non-option\n' +
      "argument must be a format string beginning with '+'\n" +
      usageHint(CommandName.DATE),
    usageExitCode(CommandName.DATE),
  )
}

// GNU `date`: the current moment, or the one `-d` names, rendered in the
// zone the command runs in. The zone is `-u`'s UTC, else the TZ of the
// command's own environment (`TZ=Asia/Hong_Kong date` and an exported TZ
// alike, as GNU reads it), else the host's local zone. It is read from
// `ctx.env`, never from process state, so concurrent workspaces cannot
// move each other's clock. `%Z` is tzdata's abbreviation (`HKT`), as GNU
// prints it, read from a table generated off zoneinfo since Intl has
// none; the Python twin reads zoneinfo itself. An operand without `+` sets
// the clock, GNU's `MMDDhhmm[[CC]YY][.ss]`: mirage has no clock to set, so it
// prints the date it names and refuses the setting, as GNU does for a user
// without the privilege. Beside `-d` it is a usage error.
async function date(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('date'))
  const u = fl.asBool('utc') || fl.asBool('universal')
  const d = fl.asStr('date') ?? null
  const reference = fl.asPath('reference') ?? null
  const datefile = fl.asPath('file') ?? null
  const resolution = fl.asBool('resolution')
  const formats = optionFormats(fl)
  if (formats.length > 1) return multipleFormats()
  const chosen = [d !== null, reference !== null, datefile !== null, resolution]
  if (chosen.filter(Boolean).length > 1) throw exclusiveError()
  if (texts.length > 1) throw extraOperandError(CommandName.DATE, texts[1] ?? '')
  let setting = texts[0] ?? null
  if (setting?.startsWith('+') === true) {
    if (formats.length > 0) return multipleFormats()
    formats.push(setting.slice(1))
    setting = null
  } else if (setting !== null && chosen.some(Boolean)) {
    throw lacksPlusError(setting)
  }
  const zone = u ? UTC_ZONE : zoneFromEnv(ctx.env)
  if (datefile !== null) return eachLine(ctx, datefile, zone, formats[0] ?? DEFAULT_FORMAT)
  // Times here are kept to the nanosecond, the resolution GNU reports for a
  // filesystem that keeps them so.
  if (resolution && formats.length === 0) return [ENC.encode('0.000000001\n'), new IOResult()]
  let dt: Date
  if (setting !== null) {
    const placed = await parsePosixTimeAsync(setting, zone, undefined, ctx.signal)
    if (placed === null) return invalidDate(setting)
    dt = placed
  } else if (d !== null) {
    // GNU ACCEPTS an empty (or blank) expression, exit 0: with no item at all
    // it names today at midnight. Measured on coreutils 9.4: `date -d ''` and
    // `date -d '   '` both print today 00:00:00 in the command's zone.
    const parsed = await named(d, zone, ctx.signal)
    // GNU's refusal, exit 1: a NaN render with exit 0 poisons whatever
    // consumed it (the 0NaN-NaN-NaN corpus failure).
    if (parsed === null) return invalidDate(d)
    dt = parsed
  } else if (reference !== null) {
    try {
      dt = await modified(ctx, reference)
    } catch (err) {
      if (!isFsError(err)) throw err
      const line = fsErrorLine(CommandName.DATE, reference, err)
      return [null, new IOResult({ exitCode: 1, stderr: encodeText(line) })]
    }
  } else if (resolution) {
    dt = new Date(0)
  } else {
    dt = systemDate()
  }
  const fmt = formats[0] ?? DEFAULT_FORMAT
  // --resolution names one nanosecond past the epoch.
  const out = asyncChain([
    await strftimeStream(dt, fmt, zone, resolution ? 1 : undefined),
    ENC.encode('\n'),
  ])
  if (setting !== null) return [out, new IOResult({ exitCode: 1, stderr: ENC.encode(CANNOT_SET) })]
  return [out, new IOResult()]
}

export const GENERAL_DATE = command({
  name: 'date',
  vfs: null,
  spec: specOf('date'),
  fn: date,
})

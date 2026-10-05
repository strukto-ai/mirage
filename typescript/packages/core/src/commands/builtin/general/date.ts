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
import { parseDateExpr, parsePosixTime } from '../../../utils/dates.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { gnuStrftime } from '../utils/strftime.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError, usageExitCode, usageHint } from '../../spec/usage.ts'
import { UsageError } from '../../errors.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { LOCAL_ZONE, UTC_ZONE, zoneFromEnv } from '../../../utils/timezone.ts'

const ENC = new TextEncoder()

// GNU date's output formats (date.c), each chosen by one option: -I takes one
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
// `opts.env`, never from process state, so concurrent workspaces cannot
// move each other's clock. `%Z` is tzdata's abbreviation (`HKT`), as GNU
// prints it, read from a table generated off zoneinfo since Intl has
// none; the Python twin reads zoneinfo itself. An operand without `+` sets
// the clock, GNU's `MMDDhhmm[[CC]YY][.ss]`: mirage has no clock to set, so it
// prints the date it names and refuses the setting, as GNU does for a user
// without the privilege. Beside `-d` it is a usage error.
function dateCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  const fl = new FlagView(opts.flags, specOf('date'))
  const u = fl.asBool('utc') || fl.asBool('universal')
  const d = fl.asStr('date') ?? null
  const formats = optionFormats(fl)
  if (formats.length > 1) return multipleFormats()
  if (texts.length > 1) throw extraOperandError(CommandName.DATE, texts[1] ?? '')
  let setting = texts[0] ?? null
  if (setting?.startsWith('+') === true) {
    if (formats.length > 0) return multipleFormats()
    formats.push(setting.slice(1))
    setting = null
  } else if (setting !== null && d !== null) {
    throw lacksPlusError(setting)
  }
  const named = u ? UTC_ZONE : zoneFromEnv(opts.env)
  const zone = named ?? LOCAL_ZONE
  let dt: Date
  if (setting !== null) {
    const placed = parsePosixTime(setting, zone)
    if (placed === null) return invalidDate(setting)
    dt = placed
  } else if (d !== null && d.trim() === '') {
    // GNU ACCEPTS an empty (or blank) expression, exit 0: gnulib's
    // parse-datetime sees no component at all and falls through to "a date
    // with no time", which is today at midnight. Measured on coreutils
    // 9.4: `date -d ''` and `date -d '   '` both print today 00:00:00 in
    // the command's zone.
    const midnight = parseDateExpr(gnuStrftime(new Date(), '%Y-%m-%d', zone), zone)
    // Today's own ISO date always parses; the fallback is for the type.
    dt = midnight ?? new Date()
  } else if (d !== null) {
    const parsed = parseDateExpr(d, zone)
    // GNU's refusal, exit 1: a NaN render with exit 0 poisons whatever
    // consumed it (the 0NaN-NaN-NaN corpus failure).
    if (parsed === null) return invalidDate(d)
    dt = parsed
  } else {
    dt = new Date()
  }
  const fmt = formats[0] ?? DEFAULT_FORMAT
  const out = ENC.encode(gnuStrftime(dt, fmt, zone) + '\n')
  if (setting !== null) return [out, new IOResult({ exitCode: 1, stderr: ENC.encode(CANNOT_SET) })]
  return [out, new IOResult()]
}

export const GENERAL_DATE = command({
  name: 'date',
  vfs: null,
  spec: specOf('date'),
  fn: dateCommand,
})

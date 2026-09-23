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
import { parseDateExpr } from '../../../utils/dates.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { pureProvision } from '../generic_bind/provision.ts'
import { DAY_NAMES, MONTH_NAMES, pad2, pad4, strftime } from '../utils/strftime.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { LOCAL_ZONE, UTC_ZONE, type Zone, zoneFromEnv } from '../../../utils/timezone.ts'

const ENC = new TextEncoder()

// RFC 5322 (email) date format — e.g. "Mon, 21 Apr 2026 06:34:55 +0000"
function formatRFC5322(dt: Date, zone: Zone): string {
  const p = zone.parts(dt)
  return `${DAY_NAMES[p.weekday] ?? ''}, ${pad2(p.day)} ${MONTH_NAMES[p.month] ?? ''} ${pad4(p.year)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${strftime(dt, '%z', zone)}`
}

// GNU `date`: the current moment, or the one `-d` names, rendered in the
// zone the command runs in. The zone is `-u`'s UTC, else the TZ of the
// command's own environment (`TZ=Asia/Hong_Kong date` and an exported TZ
// alike, as GNU reads it), else the host's local zone. It is read from
// `opts.env`, never from process state, so concurrent workspaces cannot
// move each other's clock. `%Z` is tzdata's abbreviation (`HKT`), as GNU
// prints it, read from a table generated off zoneinfo since Intl has
// none; the Python twin reads zoneinfo itself.
function dateCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  if (texts.length > 1) throw extraOperandError(CommandName.DATE, texts[1] ?? '')
  const fl = new FlagView(opts.flags, specOf('date'))
  const u = fl.asBool('u')
  const d = fl.asStr('d') ?? null
  // -I is short-only, so it lands on the disambiguated `args_I` dest
  // (`AMBIGUOUS_NAMES`); a plain `I` key is one the parser never emits.
  const argsI = fl.asBool('args_I')
  const R = fl.asBool('R')
  const named = u ? UTC_ZONE : zoneFromEnv(opts.env)
  const zone = named ?? LOCAL_ZONE
  let dt: Date
  if (d !== null && d.trim() === '') {
    // GNU ACCEPTS an empty (or blank) expression, exit 0: gnulib's
    // parse-datetime sees no component at all and falls through to "a date
    // with no time", which is today at midnight. Measured on coreutils
    // 9.4: `date -d ''` and `date -d '   '` both print today 00:00:00 in
    // the command's zone.
    const midnight = parseDateExpr(strftime(new Date(), '%Y-%m-%d', zone), zone)
    // Today's own ISO date always parses; the fallback is for the type.
    dt = midnight ?? new Date()
  } else if (d !== null) {
    const parsed = parseDateExpr(d, zone)
    if (parsed === null) {
      // GNU's refusal, exit 1: a NaN render with exit 0 poisons whatever
      // consumed it (the 0NaN-NaN-NaN corpus failure).
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`date: invalid date '${quoteText(d)}'\n`),
        }),
      ]
    }
    dt = parsed
  } else {
    dt = new Date()
  }
  let fmt: string | null = null
  for (const t of texts) {
    if (t.startsWith('+')) {
      fmt = t.slice(1)
      break
    }
  }
  let result: string
  if (argsI) {
    result = strftime(dt, '%Y-%m-%d', zone)
  } else if (R) {
    result = formatRFC5322(dt, zone)
  } else if (fmt !== null) {
    result = strftime(dt, fmt, zone)
  } else {
    result = strftime(dt, '%a %b %d %H:%M:%S %Z %Y', zone)
  }
  return [ENC.encode(result + '\n'), new IOResult()]
}

export const GENERAL_DATE = command({
  name: 'date',
  vfs: null,
  spec: specOf('date'),
  fn: dateCommand,
  provision: pureProvision,
})

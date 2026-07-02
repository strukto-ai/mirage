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
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { pureProvision } from '../generic_bind/provision.ts'

const ENC = new TextEncoder()

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function strftime(dt: Date, fmt: string, utc: boolean): string {
  const year = utc ? dt.getUTCFullYear() : dt.getFullYear()
  const month = utc ? dt.getUTCMonth() : dt.getMonth()
  const day = utc ? dt.getUTCDate() : dt.getDate()
  const dow = utc ? dt.getUTCDay() : dt.getDay()
  const hour = utc ? dt.getUTCHours() : dt.getHours()
  const minute = utc ? dt.getUTCMinutes() : dt.getMinutes()
  const second = utc ? dt.getUTCSeconds() : dt.getSeconds()
  return fmt.replace(/%([aAbBdDHIMmYypSszZjewuT%])/g, (_m, code: string) => {
    switch (code) {
      case 'a':
        return DAY_NAMES[dow] ?? ''
      case 'A': {
        const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        return full[dow] ?? ''
      }
      case 'b':
        return MONTH_NAMES[month] ?? ''
      case 'B': {
        const full = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ]
        return full[month] ?? ''
      }
      case 'd':
        return pad2(day)
      case 'D':
        return `${pad2(month + 1)}/${pad2(day)}/${pad2(year % 100)}`
      case 'H':
        return pad2(hour)
      case 'I': {
        const h12 = hour % 12 === 0 ? 12 : hour % 12
        return pad2(h12)
      }
      case 'M':
        return pad2(minute)
      case 'm':
        return pad2(month + 1)
      case 'Y':
        return pad4(year)
      case 'y':
        return pad2(year % 100)
      case 'p':
        return hour < 12 ? 'AM' : 'PM'
      case 'S':
        return pad2(second)
      case 's':
        return String(Math.floor(dt.getTime() / 1000))
      case 'z':
        return utc ? '+0000' : formatTZOffset(dt)
      case 'Z':
        return utc ? 'UTC' : ''
      case 'e':
        return String(day).padStart(2, ' ')
      case 'T':
        return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
      case 'j': {
        const start = Date.UTC(year, 0, 0)
        const diff = (utc ? dt.getTime() : Date.UTC(year, month, day)) - start
        return String(Math.floor(diff / 86_400_000)).padStart(3, '0')
      }
      case 'w':
        return String(dow)
      case 'u':
        return String(dow === 0 ? 7 : dow)
      case '%':
        return '%'
      default:
        return ''
    }
  })
}

function formatTZOffset(dt: Date): string {
  const offsetMin = -dt.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`
}

// RFC 5322 (email) date format — e.g. "Mon, 21 Apr 2026 06:34:55 +0000"
function formatRFC5322(dt: Date, utc: boolean): string {
  const dow = utc ? dt.getUTCDay() : dt.getDay()
  const day = utc ? dt.getUTCDate() : dt.getDate()
  const mon = utc ? dt.getUTCMonth() : dt.getMonth()
  const year = utc ? dt.getUTCFullYear() : dt.getFullYear()
  const hour = utc ? dt.getUTCHours() : dt.getHours()
  const minute = utc ? dt.getUTCMinutes() : dt.getMinutes()
  const second = utc ? dt.getUTCSeconds() : dt.getSeconds()
  const tz = utc ? '+0000' : formatTZOffset(dt)
  return `${DAY_NAMES[dow] ?? ''}, ${pad2(day)} ${MONTH_NAMES[mon] ?? ''} ${pad4(year)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)} ${tz}`
}

function dateCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  const u = opts.flags.u === true
  const d = typeof opts.flags.d === 'string' ? opts.flags.d : null
  const argsI = opts.flags.I === true || opts.flags.args_I === true
  const R = opts.flags.R === true
  const dt = d !== null ? new Date(d) : new Date()
  let fmt: string | null = null
  for (const t of texts) {
    if (t.startsWith('+')) {
      fmt = t.slice(1)
      break
    }
  }
  let result: string
  if (argsI) {
    result = strftime(dt, '%Y-%m-%d', u)
  } else if (R) {
    result = formatRFC5322(dt, u)
  } else if (fmt !== null) {
    result = strftime(dt, fmt, u)
  } else if (u) {
    result = strftime(dt, '%a %b %d %H:%M:%S %Z %Y', u)
  } else {
    result = strftime(dt, '%a %b %d %H:%M:%S %Y', u)
  }
  return [ENC.encode(result + '\n'), new IOResult()]
}

export const GENERAL_DATE = command({
  name: 'date',
  resource: null,
  spec: specOf('date'),
  fn: dateCommand,
  provision: pureProvision,
})

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

import type { util } from 'zod'
import { openStream, openStreamSync } from '../../../rs/stream.ts'
import { decodeText, encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import type { Zone } from '../../../utils/timezone.ts'
import { streamOutput } from './stream.ts'

/** The last padding flag, also used by Git's libc-style formatter. */
export function winningPad(flags: string): string | null {
  for (let i = flags.length - 1; i >= 0; i -= 1) {
    const flag = flags.charAt(i)
    if ('-_0+'.includes(flag)) return flag
  }
  return null
}

function config(
  dt: Date,
  zone: Zone,
  nanosecond?: number,
): Readonly<Record<string, util.JSONType>> {
  const parts = zone.parts(dt)
  return {
    year: parts.year,
    month: parts.month + 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    nanosecond: nanosecond ?? parts.ms * 1_000_000,
    epoch: Math.floor(dt.getTime() / 1000),
    offset: parts.offsetSec,
    zone: parts.abbrev,
  }
}

/** date's C-locale directives. The host supplies one timezone reading;
 * Rust owns the calendar, directives and padding. */
export function gnuStrftime(dt: Date, fmt: string, zone: Zone, nanosecond?: number): string {
  const stream = openStreamSync('strftime', config(dt, zone, nanosecond))
  try {
    stream.feed(encodeText(fmt))
    const parts = [stream.finish()]
    while (stream.busy()) parts.push(stream.drain())
    return decodeText(concat(parts))
  } finally {
    stream.close()
  }
}

/** `gnuStrftime` as output, a window at a time, so a field as wide as date
 * allows is written as date writes it rather than held. Mirrors Python's
 * `strftime_stream`. */
export async function strftimeStream(
  dt: Date,
  fmt: string,
  zone: Zone,
  nanosecond?: number,
): Promise<AsyncIterableIterator<Uint8Array>> {
  const stream = await openStream('strftime', config(dt, zone, nanosecond))
  return streamOutput(stream, encodeText(fmt))
}

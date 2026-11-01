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

import { openStreamSync } from '../../../rs/stream.ts'
import { decodeText, encodeText } from '../../../shell/bytes.ts'
import type { Zone } from '../../../utils/timezone.ts'

/** The last padding flag, also used by Git's libc-style formatter. */
export function winningPad(flags: string): string | null {
  for (let i = flags.length - 1; i >= 0; i -= 1) {
    const flag = flags.charAt(i)
    if ('-_0+'.includes(flag)) return flag
  }
  return null
}

/** GNU date's C-locale directives. The host supplies one timezone reading;
 * Rust owns the calendar, directives and padding. */
export function gnuStrftime(dt: Date, fmt: string, zone: Zone): string {
  const parts = zone.parts(dt)
  const stream = openStreamSync('strftime', {
    year: parts.year,
    month: parts.month + 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    nanosecond: parts.ms * 1_000_000,
    epoch: Math.floor(dt.getTime() / 1000),
    offset: parts.offsetSec,
    zone: parts.abbrev,
  })
  try {
    stream.feed(encodeText(fmt))
    return decodeText(stream.finish())
  } finally {
    stream.close()
  }
}

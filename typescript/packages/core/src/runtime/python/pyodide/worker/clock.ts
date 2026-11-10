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

import type { Zone, ZoneParts } from '../../../../utils/timezone.ts'

type Field = 'year' | 'month' | 'day' | 'weekday' | 'hour' | 'minute' | 'second' | 'ms'

/**
 * A `Date` whose local time is `zone`'s. Emscripten's C library builds a
 * guest's local time from this global's local fields, so the worker holds
 * this one while a program runs and the server's zone never reaches it.
 *
 * @param zone the zone the fields read in
 */
export function zonedDate(zone: Zone): DateConstructor {
  const read = (date: Date): ZoneParts | null =>
    Number.isNaN(date.getTime()) ? null : zone.parts(date)
  const field = (date: Date, name: Field): number => read(date)?.[name] ?? Number.NaN

  class ZonedDate extends Date {
    constructor(...args: [] | [number | string | Date] | number[]) {
      if (args.length === 0) super(Date.now())
      else if (args.length === 1) super(args[0])
      else {
        const [year = 0, month = 0, day = 1, hour = 0, minute = 0, second = 0, ms = 0] =
          args as number[]
        super(zone.fromWall({ year, month, day, hour, minute, second, ms }).getTime())
      }
    }

    override getTimezoneOffset(): number {
      const parts = read(this)
      return parts === null ? Number.NaN : -parts.offsetSec / 60
    }

    override getFullYear(): number {
      return field(this, 'year')
    }

    getYear(): number {
      return field(this, 'year') - 1900
    }

    override getMonth(): number {
      return field(this, 'month')
    }

    override getDate(): number {
      return field(this, 'day')
    }

    override getDay(): number {
      return field(this, 'weekday')
    }

    override getHours(): number {
      return field(this, 'hour')
    }

    override getMinutes(): number {
      return field(this, 'minute')
    }

    override getSeconds(): number {
      return field(this, 'second')
    }

    override getMilliseconds(): number {
      return field(this, 'ms')
    }
  }
  return ZonedDate as unknown as DateConstructor
}

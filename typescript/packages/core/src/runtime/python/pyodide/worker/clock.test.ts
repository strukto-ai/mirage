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

import { describe, expect, it } from 'vitest'
import { UTC_ZONE, resolveTz } from '../../../../utils/timezone.ts'
import { zonedDate } from './clock.ts'

describe('zonedDate', () => {
  const Tokyo = zonedDate(resolveTz('Asia/Tokyo'))
  const NewYork = zonedDate(resolveTz('America/New_York'))
  const Utc = zonedDate(UTC_ZONE)

  it('reads the local fields in its zone', () => {
    const date = new Tokyo(0)
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([
      1970, 0, 1, 9,
    ])
    expect(date.getTimezoneOffset()).toBe(-540)
    expect(new Utc(0).getTimezoneOffset() + 0).toBe(0)
  })

  it('follows daylight saving time', () => {
    expect(new NewYork(1784000000000).getTimezoneOffset()).toBe(240)
    expect(new NewYork(1767225600000).getTimezoneOffset()).toBe(300)
  })

  it('reads wall clock fields in its zone and carries an overflow', () => {
    expect(new Tokyo(1970, 0, 1, 9, 0, 0, 0).getTime()).toBe(0)
    expect(new Utc(1970, 12, 1).getTime()).toBe(Date.UTC(1971, 0, 1))
    expect(new Utc(1969, 11, 32, 25).getTime()).toBe(Date.UTC(1970, 0, 2, 1))
  })

  it('takes one value as Date does, and no value as now', () => {
    expect(new Utc('1970-01-01T00:00:01Z').getTime()).toBe(1000)
    expect(Math.abs(new Utc().getTime() - Date.now())).toBeLessThan(2000)
  })

  it('answers NaN for an invalid date in every zone', () => {
    expect(new Tokyo(Number.NaN).getHours()).toBeNaN()
    expect(new Tokyo(Number.NaN).getTimezoneOffset()).toBeNaN()
  })
})

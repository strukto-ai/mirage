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
import { strftime } from './strftime.ts'
import { LOCAL_ZONE, UTC_ZONE } from '../../../utils/timezone.ts'

const MOMENT = new Date(Date.UTC(2026, 0, 1, 0, 0, 1, 123))

describe('strftime GNU directives', () => {
  // Pinned against date 9.7: a width on %N keeps that many leading
  // digits and pads a wider one with zeros on the right, a width on %q
  // zero-pads on the left, and the flags change nothing on either.
  it.each([
    ['%N', '123000000'],
    ['%3N', '123'],
    ['%-N', '123000000'],
    ['%_3N', '123'],
    ['%03N', '123'],
    ['%6N', '123000'],
    ['%12N', '123000000000'],
    ['%q', '1'],
    ['%2q', '01'],
    ['%02q', '01'],
    ['%_2q', ' 1'],
    ['%-2q', '1'],
    ['%_3q', '  1'],
    ['%_q', '1'],
    ['%_-2q', '1'],
    ['%-_2q', ' 1'],
    ['%0_2q', ' 1'],
    ['%_02q', '01'],
    ['%^_2q', ' 1'],
    ['%%N', '%N'],
    ['%%q', '%q'],
    ['%Y/%q/%3N', '2026/1/123'],
    ['%-d|%_d|%5d|%^b|%#p', '1| 1|00001|JAN|am'],
    ['%0_d|%_0d|%-_d|%_-d|%-0d|%0-d', ' 1|01| 1|1|01|1'],
    ['%-3d|%_-3d|%-_3d|%0_3d|%_3d|%3d', '1|1|  1|  1|  1|001'],
    ['%_0e|%0_e|%3e|%03e|%_j|%0_j', '01| 1|  1|001|  1|  1'],
    ['%5b|%_5b|%05b|%-5b|%^_5b|%_^b', '  Jan|  Jan|00Jan|Jan|  JAN|JAN'],
    ['%+5Y|%+4Y|%+6Y|%+3Y|%+5G|%+3C|%+C', '+2026|2026|+02026|2026|+2026|+20|20'],
    ['%-D|%_D|%^D|%#D|%10D|%05D', '01/01/26|01/01/26|01/01/26|01/01/26|  01/01/26|01/01/26'],
    [
      '%12F|%+12F|%012F|%_12F|%-12F|%+5F',
      '002026-01-01|+02026-01-01|002026-01-01|  2026-01-01|2026-01-01|2026-01-01',
    ],
    [
      '%-T|%10T|%12R|%12r|%-x|%^X',
      '00:00:01|  00:00:01|       00:00| 12:00:01 AM|01/01/26|00:00:01',
    ],
    [
      '%^c|%-c|%30c',
      'THU JAN  1 00:00:01 2026|Thu Jan  1 00:00:01 2026|      Thu Jan  1 00:00:01 2026',
    ],
    [
      '%+5d|%+d|%+5b|%+2q|%_+5Y|%+_5Y|%+05Y|%0+5Y|%-+5Y|%+-5Y',
      '00001|01|00Jan|01|+2026| 2026|02026|+2026|+2026|2026',
    ],
    ['%^#B|%#^B|%#B|%^B|%#a|%^#a|%#^b', 'JANUARY|JANUARY|JANUARY|JANUARY|THU|THU|JAN'],
    ['%^#p|%#^p|%#p|%^p|%^#Z|%#Z|%#^Z|%^Z|%#d', 'am|am|am|AM|utc|utc|utc|UTC|01'],
    ['%^#B|%#^B|%#B|%^B|%#a|%^#a|%#^b', 'JANUARY|JANUARY|JANUARY|JANUARY|THU|THU|JAN'],
    ['%^#p|%#^p|%#p|%^p|%^#Z|%#Z|%#^Z|%^Z|%#d', 'am|am|am|AM|utc|utc|utc|UTC|01'],
    [
      '%:z|%::z|%:::z|%z|%_:z|%-:z|%5:z|%8:z|%_8:z|%_z|%-z|%6z|%_6z|%8::z|%5:::z',
      '+00:00|+00:00:00|+00|+0000| +0:00|+0:00|+0:00|+0000:00|   +0:00|   +0|+0|+00000|    +0|+0:00:00|+0000',
    ],
    // Without a colon the offset is one hhmm number, so `-` drops every
    // leading zero and `_` spaces the whole field.
    ['%0z|%+z|%-6z|%_8z|%08z|%3z|%-:::z', '+0000|+0000|+0|      +0|+0000000|+00|+0'],
    // A width on a name pads with spaces, or zeros under `0` and `+`,
    // and `-` drops it; `#` lowers %p and %Z and uppers a name.
    [
      '%-5a|%_5a|%05a|%^5a|%+5a|%#5a|%2a|%-5b|%-5h|%-5A|%-8p|%-5Z|%_5Z|%05Z|%5n|%-5n|%-3q',
      'Thu|  Thu|00Thu|  THU|00Thu|  THU|Thu|Jan|Jan|Thursday|AM|UTC|  UTC|00UTC|    \n|\n|1',
    ],
    // `+` signs %y and %g as it signs %Y, %G and %C, which for a
    // two-digit year means whenever the width leaves room.
    [
      '%+y|%+3y|%+5y|%+2y|%+1y|%+0y|%+3g|%+5g|%_3y|%-3y|%03y|%^+3y|%+^3y|%+3C|%+3Y|%+3G|%+5j|%+3d',
      '26|+26|+0026|26|26|26|+26|+0026| 26|26|026|+26|+26|+20|2026|2026|00001|001',
    ],
    ['%:q|%:%z|%::', '%:q|%:+0000|%::'],
  ])('%s renders %s', (fmt, expected) => {
    expect(strftime(MOMENT, fmt, UTC_ZONE)).toBe(expected)
  })

  it('pads a negative number after its sign', () => {
    // Pinned against date 9.7: zeros go after the sign, spaces before it.
    expect(strftime(new Date(-1000), '%3s|%s|%_3s|%-3s|%03s|%+3s|%5s|%_5s', UTC_ZONE)).toBe(
      '-01|-1| -1|-1|-01|-01|-0001|   -1',
    )
    expect(strftime(new Date(-100000), '%5s|%_5s|%2s', UTC_ZONE)).toBe('-0100| -100|-100')
  })

  it('lets a width pad a composite whole', () => {
    // Pinned against date 9.7: a width on a composite pads the rendered
    // whole, with spaces bare or under `_` and zeros under `0` or `+`;
    // %F alone lets a bare, `0` or `+` width reach the year.
    const moment = new Date(Date.UTC(2026, 8, 3, 5, 7, 9))
    expect(
      strftime(moment, '%12F|%-12F|%_12F|%012F|%+12F|%6F|%9F|%_9F|%+9F|%^F|%#F', UTC_ZONE),
    ).toBe(
      '002026-09-03|2026-09-03|  2026-09-03|002026-09-03|+02026-09-03|2026-09-03|2026-09-03|2026-09-03|2026-09-03|2026-09-03|2026-09-03',
    )
    expect(
      strftime(moment, '%12D|%-12D|%_12D|%012D|%+12D|%12T|%012T|%+12T|%12R|%12r', UTC_ZONE),
    ).toBe(
      '    09/03/26|09/03/26|    09/03/26|000009/03/26|000009/03/26|    05:07:09|000005:07:09|000005:07:09|       05:07| 05:07:09 AM',
    )
    expect(strftime(moment, '%12c|%^12c|%12x|%12X', UTC_ZONE)).toBe(
      'Thu Sep  3 05:07:09 2026|THU SEP  3 05:07:09 2026|    09/03/26|    05:07:09',
    )
  })

  it('lets a width replace the default digits', () => {
    // Pinned against date 9.7: a width on a numeric directive replaces
    // its default padding rather than adding to it, and %e, %k and %l
    // fill with spaces where the rest fill with zeros.
    const narrow = new Date(Date.UTC(2026, 0, 3, 5, 7, 9))
    expect(
      strftime(
        narrow,
        '%1d|%2d|%3d|%_3d|%-3d|%03d|%1j|%2j|%4j|%1e|%3e|%_1e|%03e|%-e|%0e|%_e',
        UTC_ZONE,
      ),
    ).toBe('3|03|003|  3|3|003|3|03|0003|3|  3|3|003|3|03| 3')
    expect(
      strftime(narrow, '%1Y|%5Y|%1y|%1m|%_m|%1H|%1M|%1S|%1k|%3k|%1l|%1u|%3u|%1w|%1U|%1W', UTC_ZONE),
    ).toBe('2026|02026|26|1| 1|5|7|9|5|  5|5|6|006|6|0|0')
    expect(
      strftime(narrow, '%1V|%1C|%1g|%1G|%1I|%+5d|%+1d|%+3e|%^3d|%#3d|%-d|%-_3d|%_-3d', UTC_ZONE),
    ).toBe('1|20|26|2026|5|00003|3|003|003|003|3|  3|3')
    expect(strftime(narrow, '%5a|%05a|%-5a|%_5a', UTC_ZONE)).toBe('  Sat|00Sat|Sat|  Sat')
  })

  it('renders the local zone with its colon forms', () => {
    const prior = process.env.TZ
    process.env.TZ = 'Asia/Kolkata'
    try {
      expect(strftime(new Date(0), '%:z|%::z|%:::z|%_:z|%8:z|%-z|%_z|%3z|%08z', LOCAL_ZONE)).toBe(
        '+05:30|+05:30:00|+05:30| +5:30|+0005:30|+530| +530|+530|+0000530',
      )
      process.env.TZ = 'Etc/GMT-1'
      expect(strftime(new Date(0), '%z|%-z|%_z|%6z|%_8z|%3z|%-:z|%_:::z', LOCAL_ZONE)).toBe(
        '+0100|+100| +100|+00100|    +100|+100|+1:00| +1',
      )
    } finally {
      if (prior === undefined) delete process.env.TZ
      else process.env.TZ = prior
    }
  })
})

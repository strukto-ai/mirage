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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICONV_MULTIBYTE_DIGESTS, iconvMultibyteDigests } from '../../../test-utils.ts'
import { SJIS, hostDecoder, logger, multibyteTable, type MultibyteSpec } from './iconv_multibyte.ts'

afterEach(() => {
  delete logger.debug
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('multibyte tables', () => {
  it.each(ICONV_MULTIBYTE_DIGESTS)('%s matches the pinned digests', async (spec, ...expected) => {
    expect(await iconvMultibyteDigests(spec)).toEqual(expected)
  })

  it.each([false, true])(
    'logs expected decoder failures only with an opt-in sink (%s)',
    (enabled) => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      const messages: string[] = []
      if (enabled) logger.debug = (message) => messages.push(message)
      const unsupported = { ...SJIS, codec: 'mirage-test-unsupported-encoding' }
      expect(hostDecoder(unsupported)).toBeNull()
      expect(hostDecoder(unsupported)).toBeNull()
      const unmapped: MultibyteSpec = {
        ...SJIS,
        blocks: [[[[0x81, 0x81]], [[0xad, 0xae]]]],
        remapped: [],
      }
      const table = multibyteTable(unmapped)
      expect(table.size).toBe(0)
      expect(multibyteTable(unmapped)).toBe(table)
      expect(debug).not.toHaveBeenCalled()
      expect(messages).toEqual(
        enabled
          ? [
              expect.stringContaining(
                'iconv: no host decoder for mirage-test-unsupported-encoding:',
              ),
              expect.stringContaining(
                'iconv: shift_jis table skipped 2 undecodable sequences; first: 81ad:',
              ),
            ]
          : [],
      )
    },
  )

  it.each(['construct', 'decode'])('propagates unexpected decoder errors during %s', (phase) => {
    const error = new Error('unexpected decoder failure')
    if (phase === 'construct') {
      vi.stubGlobal(
        'TextDecoder',
        vi.fn(function () {
          throw error
        }),
      )
    } else {
      vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(() => {
        throw error
      })
    }
    expect(() => multibyteTable({ ...SJIS })).toThrow(error)
  })
})

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
import { sha256Hex } from '../../../utils/hash.ts'
import {
  EUC_CN,
  EUC_JP,
  EUC_KR,
  GB18030,
  GBK,
  SJIS,
  type MultibyteSpec,
  multibyteReverse,
  multibyteTable,
} from './iconv_multibyte.ts'

// The digests the Python twin asserts too: the host decoder only seeds a
// table, so two hosts agree exactly when these do. Every entry was checked
// against glibc 2.41 on debian:stable-slim, both directions.
const DIGESTS: [MultibyteSpec, number, string, number, string][] = [
  [GBK, 21791, 'bba66856a1a44bdc', 21920, '4013fbd0c747f579'],
  [EUC_CN, 7445, 'e73a16723240a945', 7573, 'acabc939aa1cb893'],
  [GB18030, 63360, '995fabe77efceaa4', 63488, '56a3c65aa0c1b946'],
  [EUC_KR, 8227, 'f1f8fe46cc836ea0', 8388, '96d8b6b82ea1a6de'],
  [SJIS, 6879, '9e31ef626b7726f0', 7075, '152ab23536e0befb'],
  [EUC_JP, 13009, '0a3c10912de393e1', 13169, 'af425d9e826f2b95'],
]

async function digest(entries: Iterable<[number, number]>, width: number): Promise<string> {
  const text = [...entries]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k.toString(16)}:${v.toString(16).padStart(width, '0')}\n`)
    .join('')
  return (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16)
}

describe('multibyte tables', () => {
  it.each(DIGESTS)('%s matches the pinned digests', async (spec, size, sum, rsize, rsum) => {
    const table = multibyteTable(spec)
    const reverse = multibyteReverse(spec)
    expect([table.size, await digest(table, 1)]).toEqual([size, sum])
    expect([reverse.size, await digest(reverse, 2)]).toEqual([rsize, rsum])
  })
})

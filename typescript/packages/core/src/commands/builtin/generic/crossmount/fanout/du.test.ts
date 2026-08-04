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
import { IOResult } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import type { OperandRun } from '../types.ts'
import { duTotal } from './du.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function op(data: string, exitCode = 0): OperandRun {
  const path = '/a/x'
  return {
    scope: new PathSpec({
      virtual: path,
      directory: path,
      resolved: true,
      resourcePath: mountKey(path, ''),
    }),
    data: ENC.encode(data),
    io: new IOResult({ exitCode }),
  }
}

describe('duTotal', () => {
  it('strips per-run totals and sums', () => {
    const out = DEC.decode(
      duTotal([op('5\t/a/sub\n5\ttotal\n'), op('3\t/b/c.txt\n3\ttotal\n')], false),
    )
    expect(out).toBe('5\t/a/sub\n3\t/b/c.txt\n8\ttotal\n')
  })

  it('humanizes from exact bytes without rounding twice', () => {
    // runFanout forces -h off on the native runs, so the rows arrive in
    // bytes: 1500 + 1500 is 2.9K, not the 3.0K that summing two "1.5K"
    // readings back through parseSize would give.
    const out = DEC.decode(
      duTotal([op('1500\t/a/x\n1500\ttotal\n'), op('1500\t/b/z\n1500\ttotal\n')], true),
    )
    expect(out).toBe('1.5K\t/a/x\n1.5K\t/b/z\n2.9K\ttotal\n')
  })

  it('leaves a row without a tab alone', () => {
    expect(DEC.decode(duTotal([op('odd-row\n0\ttotal\n')], true))).toBe('odd-row\n0B\ttotal\n')
  })
})

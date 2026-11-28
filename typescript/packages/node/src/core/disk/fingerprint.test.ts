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

import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RACY_WINDOW_NS } from '@struktoai/mirage-core/utils/constants'
import { describe, expect, it } from 'vitest'
import { tokenOf } from './fingerprint.ts'

function settled(st: BigIntStats): bigint {
  return (st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs) + RACY_WINDOW_NS
}

function written(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'fp-')), 'f')
  writeFileSync(path, text)
  return path
}

describe('tokenOf', () => {
  it('names a settled entry by its device, inode and both times', () => {
    const st = statSync(written('one'), { bigint: true })
    expect(tokenOf(st, settled(st))).toBe(
      `${String(st.dev)}:${String(st.ino)}:${String(st.ctimeNs)}:${String(st.mtimeNs)}`,
    )
  })

  it('gives an entry inside the racy window none', () => {
    const st = statSync(written('one'), { bigint: true })
    expect(tokenOf(st, settled(st) - 1n)).toBeNull()
  })

  it('moves on a same-size rewrite', () => {
    const path = written('one')
    const at = statSync(path)
    utimesSync(path, at.atime, new Date(at.mtimeMs - 1000))
    const before = statSync(path, { bigint: true })
    writeFileSync(path, 'two')
    const after = statSync(path, { bigint: true })
    const now = settled(after) > settled(before) ? settled(after) : settled(before)
    expect(tokenOf(before, now)).not.toBe(tokenOf(after, now))
  })
})

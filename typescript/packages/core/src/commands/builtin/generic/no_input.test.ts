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
import type { Accessor } from '../../../accessor/base.ts'
import { materialize } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import type { RegisteredCommand } from '../../config.ts'
import { BOX_AWK } from '../box/awk.ts'
import { DATABRICKS_VOLUME_AWK } from '../databricks_volume/awk.ts'
import { DROPBOX_AWK } from '../dropbox/awk.ts'
import { GITHUB_AWK } from '../github/awk.ts'

const BESPOKE_AWK: [string, RegisteredCommand][] = [
  ...BOX_AWK.map((c): [string, RegisteredCommand] => ['box', c]),
  ...DATABRICKS_VOLUME_AWK.map((c): [string, RegisteredCommand] => ['databricks_volume', c]),
  ...DROPBOX_AWK.map((c): [string, RegisteredCommand] => ['dropbox', c]),
  ...GITHUB_AWK.map((c): [string, RegisteredCommand] => ['github', c]),
]

describe('bespoke awk with no paths and no stdin', () => {
  // GNU semantics: no stdin behaves like empty input, awk '{print}' </dev/null
  // exits 0 with no output. No accessor calls happen on this path.
  for (const [name, cmd] of BESPOKE_AWK) {
    it(`${name} awk exits 0 with empty output`, async () => {
      const result = await cmd.fn(null as unknown as Accessor, [], ['{print}'], {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
        resource: null as unknown as Resource,
      })
      expect(result).not.toBeNull()
      if (result === null) return
      const [out, io] = result
      expect(io.exitCode).toBe(0)
      if (out !== null) {
        const buf =
          out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
        expect(buf.byteLength).toBe(0)
      }
    })
  }
})

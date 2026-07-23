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
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

describe.each(NATIVE_BACKENDS)('native numfmt (%s backend)', (kind) => {
  it('scales units and supports suffix grouping', async () => {
    const env = makeEnv(kind)
    try {
      expect(await env.mirage('numfmt --to=si 1000')).toBe('1K\n')
      expect(await env.mirage('numfmt --from=iec-i 1Ki')).toBe('1024\n')
      expect(await env.mirage('numfmt --grouping --suffix=B 1234B')).toBe('1,234B\n')
    } finally {
      await env.cleanup()
    }
  })
})

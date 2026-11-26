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
import { REDACTED_SECRET, redactedConfigDump } from '../secrets.ts'
import { Mem0Config } from './config.ts'

describe('Mem0Config', () => {
  it.each(['', '  '])('refuses the empty apiKey %j', (apiKey) => {
    expect(() => Mem0Config.parse({ apiKey, userId: 'alex' })).toThrow(
      'Mem0 apiKey cannot be empty',
    )
  })

  it('keeps apiKey a secret', () => {
    const dump = redactedConfigDump(Mem0Config, { apiKey: 'k', userId: 'alex' })
    expect(dump.apiKey).toBe(REDACTED_SECRET)
  })
})

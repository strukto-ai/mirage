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
import { LangfuseConfig } from './config.ts'

const KEYS = { publicKey: 'pk', secretKey: 'sk' }

describe('LangfuseConfig', () => {
  it.each(['publicKey', 'secretKey'])('refuses an empty %s', (field) => {
    for (const key of ['', '  ']) {
      expect(() => LangfuseConfig.parse({ ...KEYS, [field]: key })).toThrow(
        `Langfuse ${field} cannot be empty`,
      )
    }
  })

  it('keeps secretKey a secret', () => {
    const dump = redactedConfigDump(LangfuseConfig, KEYS)
    expect(dump.publicKey).toBe('pk')
    expect(dump.secretKey).toBe(REDACTED_SECRET)
  })
})

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
import { buildVfs, knownVfsNames } from '../registry.ts'

describe('SSH registry entry', () => {
  it('is in the known list', () => {
    expect(knownVfsNames()).toContain('ssh')
  })

  it('builds an SSHVFS from snake_case config', async () => {
    const r = await buildVfs('ssh', {
      host: 'example.com',
      identity_file: '~/.ssh/id_ed25519',
      port: 22,
    })
    expect(r.kind).toBe('ssh')
    await r.close()
  })
})

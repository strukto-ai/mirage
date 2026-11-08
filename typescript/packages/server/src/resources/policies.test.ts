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

import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { describe, expect, it } from 'vitest'
import { withPolicies } from './policies.ts'

const SOURCE = 'def pre_command(ctx):\n    return None\n'

describe('withPolicies', () => {
  it('gives a script that names a saved policy its source, and leaves paths', async () => {
    const store = memoryResourceStore()
    await store.createPolicy({ name: 'guard.py', source: SOURCE })
    const written = {
      profiles: {
        reviewer: {
          policy: {
            pre_command: [
              { script: 'guard.py' },
              { script: 'unsaved.py' },
              { script: './local.py' },
            ],
          },
        },
      },
    }
    expect(await withPolicies(store, written)).toEqual({
      profiles: {
        reviewer: {
          policy: {
            pre_command: [
              { script: { source: SOURCE, language: 'python' } },
              { script: 'unsaved.py' },
              { script: './local.py' },
            ],
          },
        },
      },
    })
  })

  it('answers the config itself when no script names a saved policy', async () => {
    const written = { profiles: { reviewer: { policy: { pre_command: [{ script: 'a.py' }] } } } }
    expect(await withPolicies(memoryResourceStore(), written)).toBe(written)
  })
})

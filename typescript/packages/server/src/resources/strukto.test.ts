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
import { withEntries } from './strukto.ts'

describe('withEntries', () => {
  it('keeps a plain field its type and reads a sealed one from the source', async () => {
    const store = memoryResourceStore()
    await store.createEntry('vfs', {
      name: 'db',
      type: 'postgres',
      fields: { schemas: ['public', 'analytics'] },
      sealed: { password: 'pw' },
    })
    const password = { from: 'strukto', ref: 'db', key: 'password' }
    const written = {
      mounts: {
        '/db': {
          vfs: 'postgres',
          config: { schemas: { from: 'strukto', ref: 'db', key: 'schemas' }, password },
        },
      },
    }
    const cfg = await withEntries(store, written, ['db'])
    const mount = (cfg.mounts as Record<string, { config: Record<string, unknown> }>)['/db']
    expect(mount?.config.schemas).toEqual(['public', 'analytics'])
    expect(mount?.config.password).toEqual(password)
    expect(cfg.secrets?.strukto).toEqual({
      source: 'strukto',
      config: { entries: { db: { schemas: '["public","analytics"]', password: 'pw' } } },
    })
  })
})

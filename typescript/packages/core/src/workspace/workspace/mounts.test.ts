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

import { RAMResource } from '../../resource/ram/ram.ts'
import { Limit, MountMode } from '../../types.ts'
import { normalizeResources } from './mounts.ts'

describe('normalizeResources', () => {
  it('keeps a bare resource with no pinned mode', () => {
    const resource = new RAMResource()
    const normalized = normalizeResources({ '/a': resource })
    expect(normalized.bare['/a']).toBe(resource)
    expect(normalized.modes['/a']).toBeUndefined()
    expect(normalized.commandLimits['/a']).toBeUndefined()
  })

  it('pins the mode from a pair entry', () => {
    const normalized = normalizeResources({ '/a': [new RAMResource(), MountMode.READ] })
    expect(normalized.modes['/a']).toBe(MountMode.READ)
  })

  it('carries commandLimits from a triple entry', () => {
    const guard = new Limit({ timeoutSeconds: 1 })
    const normalized = normalizeResources({
      '/a': [new RAMResource(), MountMode.READ, { curl: guard }],
    })
    expect(normalized.commandLimits['/a']).toEqual({ curl: guard })
  })
})

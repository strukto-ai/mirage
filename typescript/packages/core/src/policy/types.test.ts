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
import { Answer } from './types.ts'

// Mirrors python/tests/policy/test_types.py.

describe('Answer', () => {
  it('is its kind and its own fields', () => {
    expect(Answer.parse({ kind: 'deny', reason: 'no' })).toEqual({ kind: 'deny', reason: 'no' })
    expect(Answer.parse({ kind: 'ask' }).reason).toBeUndefined()
    expect(Answer.parse({ kind: 'route', runtime: 'docker' }).runtime).toBe('docker')
    expect(Answer.parse({ kind: 'route', runtime: 'docker', reason: 'x' })).toEqual({
      kind: 'route',
      runtime: 'docker',
      reason: 'x',
    })
  })

  it.each([
    { kind: 'allow' },
    { kind: 'route' },
    { kind: 'deny', runtime: 'docker' },
    { kind: 'ask', policy: 'Mine' },
    { deny: 'x' },
  ])('refuses any other shape: %j', (data) => {
    expect(Answer.safeParse(data).success).toBe(false)
  })
})

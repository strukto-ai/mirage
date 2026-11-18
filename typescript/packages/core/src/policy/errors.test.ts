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
import { describeDecision } from './errors.ts'

describe('describeDecision', () => {
  it('carries the reason the stderr line dropped', () => {
    expect(
      describeDecision({
        kind: 'deny',
        reason: 'user rule',
        policy: 'RulePolicy',
        askId: null,
      }),
    ).toBe('policy denied: user rule')
    expect(
      describeDecision({
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        askId: 'abc123',
      }),
    ).toBe('requires approval: sign-off (ask abc123)')
    expect(
      describeDecision({
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        askId: null,
      }),
    ).toBe('requires approval: sign-off (ask )')
    expect(
      describeDecision({
        kind: 'failed',
        reason: 'Raising failed',
        policy: 'Raising',
        askId: null,
      }),
    ).toBe('policy Raising failed')
  })
})

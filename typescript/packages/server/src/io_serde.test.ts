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
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { ioResultToDict } from './io_serde.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('ioResultToDict', () => {
  it('carries a null refusal on an ordinary run', () => {
    expect(ioResultToDict(new ExecuteResult(enc('hi\n'), enc(''), 0))).toEqual({
      kind: 'io',
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      refusal: null,
    })
  })

  it('serializes the refusal record beside the bash-voiced stderr', () => {
    const refused = new ExecuteResult(enc(''), enc('rm: Permission denied\n'), 126, {
      kind: 'pending',
      reason: 'sign-off',
      policy: '',
      scope: 'command',
      askId: 'abc123',
    })
    expect(ioResultToDict(refused)).toEqual({
      kind: 'io',
      exitCode: 126,
      stdout: '',
      stderr: 'rm: Permission denied\n',
      refusal: {
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        scope: 'command',
        askId: 'abc123',
      },
    })
  })
})

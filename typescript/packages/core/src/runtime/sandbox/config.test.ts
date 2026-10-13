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
import { requireId } from './config.ts'
import { E2BRuntime } from './e2b/runtime.ts'

describe('requireId', () => {
  it.each(['', '  ', undefined, 3])('refuses %j, which would reach the provider as no name', (id) => {
    expect(() => {
      requireId('docker', 'container', id)
    }).toThrow('docker config needs a nonblank container')
  })

  it('takes an id with something in it', () => {
    expect(() => {
      requireId('docker', 'container', 'box')
    }).not.toThrow()
  })

  it('guards a provider at construction', () => {
    expect(() => new E2BRuntime({ config: { sandboxId: ' ' } })).toThrow(
      'e2b config needs a nonblank sandboxId',
    )
  })
})

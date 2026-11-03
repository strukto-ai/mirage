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
import { currentRequest, inRequest, withinRequest } from './request.ts'

describe('withinRequest', () => {
  it('binds a request of its own when none is bound', async () => {
    expect(currentRequest()).toBeNull()
    const first = await withinRequest(() => Promise.resolve(currentRequest()))
    const second = await withinRequest(() => Promise.resolve(currentRequest()))
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    expect(currentRequest()).toBeNull()
  })

  it('keeps the request already being answered', async () => {
    await inRequest(async () => {
      const outer = currentRequest()
      expect(await withinRequest(() => Promise.resolve(currentRequest()))).toBe(outer)
    })
  })
})

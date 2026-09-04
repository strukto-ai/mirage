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

import { expect, it, vi } from 'vitest'
import { CacheEntry } from './entry.ts'

it.each([
  [1_009_900, false],
  [1_010_000, true],
])('public expired getter uses system time at %i ms', (now, expected) => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const entry = new CacheEntry({ cachedAt: 1000, size: 1, ttl: 10 })
    expect(entry.expired).toBe(expected)
    expect(new CacheEntry({ cachedAt: 0, size: 1 }).expired).toBe(false)
  } finally {
    vi.restoreAllMocks()
  }
})

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

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { LISTENED_CALLS, PASSTHROUGH_CALLS, REFUSED_CALLS, ROUTED_CALLS } from './constants.ts'

const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown> & {
  promises: Record<string, unknown>
}

function functions(target: Record<string, unknown>): string[] {
  return Object.keys(target).filter(
    (name) => typeof target[name] === 'function' && !/^[A-Z]/.test(name),
  )
}

describe('the call tables', () => {
  // A function in none of them keeps node's own answer with a mounted
  // path in hand, so a node release that adds one fails here first.
  it('classify every fs function once, in all its spellings', () => {
    const tables = [
      new Set<string>(ROUTED_CALLS),
      new Set(Object.keys(REFUSED_CALLS)),
      PASSTHROUGH_CALLS,
    ]
    const names = new Set(
      [...functions(fs), ...functions(fs.promises)].map((name) => name.replace(/Sync$/, '')),
    )
    for (const name of names) {
      expect(tables.filter((table) => table.has(name)).length, name).toBe(1)
    }
  })

  it('name only refused calls as listened', () => {
    for (const name of LISTENED_CALLS) expect(REFUSED_CALLS[name], name).toBeDefined()
  })
})

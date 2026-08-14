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

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The tiers that persist through the record client. Any of them appearing in an
// import here means the substrate has grown a dependency on one of its own
// consumers. Mirrors python/tests/workspace/record/test_layering.py.
const CONSUMERS = ['../session/', '../store/', '../mount/', '../namespace/']

describe('record tier layering', () => {
  it('imports none of the tiers that persist through it', () => {
    // Sessions, the namespace node table and workspace metadata are three
    // tables that persist the same way; the client is that substrate and
    // nothing more. It used to live inside the session package, so the other
    // two imported upward into it, and the graph claimed sessions were
    // foundational to namespaces and workspace state.
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const offenders: string[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const source = readFileSync(new URL(name, import.meta.url), 'utf8')
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const target = match[1] ?? ''
        if (CONSUMERS.some((bad) => target.startsWith(bad))) {
          offenders.push(`${name} imports ${target}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

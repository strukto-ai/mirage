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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SPECS, specFlagNames } from './spec/index.ts'

// A typo'd FlagView query fails here, not at the first runtime hit.
// FlagView's spec binding throws when a command queries a name its spec
// never declares — but only on the code path that runs. This scans
// every source module under commands/ that binds a spec (`specOf('x')`
// or `SPECS['x']`/`SPECS.x` appears in it) and checks each literal
// query name against the union of those specs' dests, so an undeclared
// spelling is caught with zero coverage. Mirrors Python's
// tests/commands/test_flag_query_names.py.

const QUERY_RE = /\.(?:asBool|asInt|asFloat|asStr|asList|raw)\(\s*'([^']+)'\s*\)/g
const SPEC_RE = /(?:specOf\(\s*'([^']+)'\s*\)|SPECS\[\s*'([^']+)'\s*\]|SPECS\.([A-Za-z_$][\w$]*))/g

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      yield full
    }
  }
}

describe('flag query names', () => {
  it('every literal FlagView query names a dest of a spec bound in its module', () => {
    const root = join(import.meta.dirname, '.')
    const offenders: string[] = []
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8')
      const keys = new Set<string>()
      for (const m of src.matchAll(SPEC_RE)) {
        const key = m[1] ?? m[2] ?? m[3]
        if (key !== undefined) keys.add(key)
      }
      if (keys.size === 0) continue
      const allowed = new Set<string>()
      for (const key of keys) {
        const spec = SPECS[key]
        if (spec !== undefined) {
          for (const name of specFlagNames(spec)) allowed.add(name)
        }
      }
      if (allowed.size === 0) continue
      for (const m of src.matchAll(QUERY_RE)) {
        const name = m[1]
        if (name !== undefined && !allowed.has(name)) {
          const line = String(src.slice(0, m.index).split('\n').length)
          offenders.push(
            `${file.slice(root.length + 1)}:${line}: ${m[0]} — not a dest of ` +
              `[${[...keys].sort().join(', ')}]`,
          )
        }
      }
    }
    expect(
      offenders,
      'these FlagView queries name a flag no spec bound in the module declares ' +
        '(typo, or the wrong spec):\n' +
        offenders.join('\n'),
    ).toEqual([])
  })
})

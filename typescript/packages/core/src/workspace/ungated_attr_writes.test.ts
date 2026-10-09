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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

// `setAttr` is the *ungated* attribute entry point: it writes the record and
// asks no policy. That is correct only where this operand's own path
// already cleared `preSession`, which is a per-call-site fact and not a
// property of the function it sits in. Reading a nearby `view.set` and
// assuming it covers the name at hand is how three separate bugs
// shipped: `readonly NAME` froze a refused name, `declare -x NAME`
// exported a host-seeded credential, and `SECRET=x cmd` handed one to
// the command.
//
// So every call site is written down here with the reason it is
// allowed. A new one fails this test until someone states which gated
// write covers it, or routes it through `view.mark` instead. This is
// the mirror of `tests/workspace/test_ungated_attr_writes.py`.
const ALLOWED: Record<string, string> = {
  'workspace/executor/builtins/declare/declare.ts::markWritten':
    "only when the name resolves where it did before the caller's " +
    '`view.set` gated it; a write that re-aimed a `declare -n` ' +
    'reference marks its new target through `view.mark`',
  'workspace/node/command_dispatch.ts::executeCommand':
    'the prefix-assignment loop calls `preSessionGate` explicitly ' +
    'before seeding, since `seedVar` is the ungated entry point',
  'workspace/session/shell_dirs.ts::changeDir':
    "the shell's own bookkeeping for the two fixed names PWD and " +
    'OLDPWD as part of a cd the router already authorized, not a name ' +
    'the agent chose; an agent-typed `PWD=x` is an ordinary ' +
    'assignment and goes through the session view',
  'workspace/session/state.ts::markVar':
    'this is the gated session view itself: the write lands after ' +
    '`ensureVarVisible` and `preSessionGate`',
}

const DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out.sort()
}

function callSites(): Set<string> {
  const found = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('setAttr(')) continue
    const rel = relative(SRC, file).split('\\').join('/')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('setAttr(') || line.includes('function setAttr(')) {
        return
      }
      let owner = '<top-level>'
      for (let j = i; j >= 0; j--) {
        const match = DECL.exec(lines[j] ?? '')
        if (match?.[1] !== undefined) {
          owner = match[1]
          break
        }
      }
      found.add(`${rel}::${owner}`)
    })
  }
  return found
}

describe('ungated attribute writes', () => {
  it('every call site is accounted for', () => {
    const unexplained = [...callSites()].filter((site) => !(site in ALLOWED))
    expect(
      unexplained,
      'ungated setAttr call site with no stated reason. Either name the ' +
        'gated write that covers this operand and add it to ALLOWED, or ' +
        'route the mark through `view.mark` so `preSession` sees it.',
    ).toEqual([])
  })

  it('names no call site that is gone', () => {
    const sites = callSites()
    const stale = Object.keys(ALLOWED).filter((site) => !sites.has(site))
    expect(stale, 'ALLOWED names a call site that is gone').toEqual([])
  })
})

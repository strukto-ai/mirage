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

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The FlagView `no-restricted-syntax` rule was dead from the day it was
// written: a later flat-config object set the same rule for a strictly
// wider glob, and flat config REPLACES rule options rather than
// concatenating them, so the later one-entry array won and the flag
// selectors never ran (issue #1089 item 11b). Nothing caught it, because
// the config was still syntactically present and eslint reported clean.
// This test reads the repo's own config through eslint's resolution and
// then runs the resolved options over a probe, so a future edit that
// re-shadows either family fails here rather than going quiet.
const TS_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const RULE = 'no-restricted-syntax'

const COMMAND_FILE = join(TS_ROOT, 'packages/core/src/commands/builtin/generic/cat.ts')
const PLAIN_FILE = join(TS_ROOT, 'packages/core/src/utils/sort.ts')
const EXEMPT_FILE = join(TS_ROOT, 'packages/core/src/commands/config.ts')
const TEST_FILE = join(TS_ROOT, 'packages/core/src/commands/flag_query_names.test.ts')

const PROBE = `function probe(opts, inv, xs, name, parsed) {
  const flags = opts.flags
  xs.sort()
  const bag = { ...flags }
  bag[name] = true
  return [
    opts.flags.help,
    flags.show_all,
    flags[name],
    inv.flags.json,
    parsed.showAll,
    bag[name],
  ]
}
`

async function resolvedSelectors(file: string): Promise<{ selector: string; message: string }[]> {
  const { ESLint } = await import('eslint')
  const eslint = new ESLint({ cwd: TS_ROOT })
  const rules = (
    (await eslint.calculateConfigForFile(file)) as {
      rules?: Record<string, unknown>
    }
  ).rules
  const entry = rules?.[RULE]
  if (!Array.isArray(entry)) return []
  return entry.slice(1) as { selector: string; message: string }[]
}

function flagEntries(entries: { message: string }[]): { message: string }[] {
  return entries.filter((e) => e.message.includes('FlagView'))
}

function sortEntries(entries: { selector: string }[]): { selector: string }[] {
  return entries.filter((e) => e.selector.includes("'sort'"))
}

describe('no-restricted-syntax flag-bag rule', () => {
  it('resolves both selector families for a command module', async () => {
    const entries = await resolvedSelectors(COMMAND_FILE)
    expect(sortEntries(entries).length).toBe(1)
    expect(flagEntries(entries).length).toBeGreaterThanOrEqual(4)
  })

  it('keeps the .sort() selector for a module outside commands/', async () => {
    const entries = await resolvedSelectors(PLAIN_FILE)
    expect(sortEntries(entries).length).toBe(1)
    expect(flagEntries(entries)).toEqual([])
  })

  it('keeps the .sort() selector for a spec-layer module the flag rule exempts', async () => {
    const entries = await resolvedSelectors(EXEMPT_FILE)
    expect(sortEntries(entries).length).toBe(1)
    expect(flagEntries(entries)).toEqual([])
  })

  it('exempts test files from both families', async () => {
    expect(await resolvedSelectors(TEST_FILE)).toEqual([])
  })

  it('reports every flag-bag shape the resolved options are meant to catch', async () => {
    const { Linter } = await import('eslint')
    const entries = await resolvedSelectors(COMMAND_FILE)
    const messages = new Linter().verify(PROBE, {
      rules: { [RULE]: ['error', ...entries] },
    })
    const flagged = messages.filter((m) => m.message.includes('FlagView')).map((m) => m.line)
    // 2: `const flags = opts.flags`, the alias every read below it hid
    // behind; 7/8/9/10: opts.flags.help, flags.show_all, flags[name],
    // inv.flags.json. Line 5's `bag[name] = true` and line 11's
    // `parsed.showAll` must NOT appear: a bag a wrapper builds to hand
    // down stays writable, and a parsed flag struct is not a bag.
    expect(flagged).toEqual([2, 7, 8, 9, 10])
    expect(messages.filter((m) => m.message.includes('comparator')).map((m) => m.line)).toEqual([3])
  })
})

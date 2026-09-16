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

import type { Linter as LinterTypes } from 'eslint'

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

// TypeScript source, parsed with typescript-eslint's parser and no type
// information: every selector in the rule is syntactic, and a plain-JS
// probe could not carry the type annotation the declaration rule reads,
// which would leave the probe narrower than the rule it checks.
const PROBE = `function takesBag(bag: Record<string, FlagValue>, flags: Record<string, FlagValue>) {
  const copy = { ...bag }
  copy.H = true
  copy[bag.name] = true
  return [bag.name, bag.show_all, bag[flags.name]]
}

function reads(opts, inv, xs, name, parsed) {
  const flags = opts.flags
  xs.sort()
  return [
    opts.flags.help,
    flags.show_all,
    flags[name],
    inv.flags.json,
    parsed.showAll,
    parsed.lines,
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
    const tseslint = await import('typescript-eslint')
    const entries = await resolvedSelectors(COMMAND_FILE)
    const messages = new Linter().verify(PROBE, {
      languageOptions: { parser: tseslint.parser as LinterTypes.Parser },
      rules: { [RULE]: ['error', ...entries] },
    })
    const flagged = messages.filter((m) => m.message.includes('FlagView')).map((m) => m.line)
    // 4:  `bag.name` read inside a subscript ASSIGNMENT's key -- the
    //     write is exempt, the read in it is not.
    // 5:  `bag.name`, `bag.show_all`, `bag[flags.name]` -- a SIMPLE dest
    //     as well as an underscored one, plus the computed read. The
    //     simple one is what escaped before this rule was widened.
    // 9:  `const flags = opts.flags`, the alias every read below it hid
    //     behind. 12/13/14/15: opts.flags.help, flags.show_all,
    //     flags[name], inv.flags.json.
    // Not reported, all deliberate: line 3's `copy.H = true` and line 4's
    // subscript on the left (a bag a wrapper builds to hand down stays
    // writable, as python's regex also allows), line 5's `flags.name` (a
    // simple dest off `flags`, which the declaration rule below forbids
    // at its source instead), and lines 16/17's `parsed.showAll` /
    // `parsed.lines` (a parsed flag struct is not a bag).
    expect(flagged).toEqual([4, 5, 5, 5, 9, 12, 13, 14, 15])
    expect(messages.filter((m) => m.message.includes('comparator')).map((m) => m.line)).toEqual([
      10,
    ])
    // The declaration rule is what makes the read rules above precise:
    // without it a new `flags`-named bag parameter would read simple
    // dests unreported, which is the hole this probe exists to pin.
    expect(
      messages.filter((m) => m.message.includes('Name a raw flag bag')).map((m) => m.line),
    ).toEqual([1])
  })
})

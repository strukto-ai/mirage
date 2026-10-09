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

import { compileSpec } from '../../commands/spec/compile.ts'
import { describe, expect, it } from 'vitest'
import { TRELLO_COMMANDS } from '../../commands/builtin/trello/index.ts'
import type { Command } from '../../commands/config.ts'
import { PROMPT, WRITE_PROMPT } from './prompt.ts'

const TEXT = `${PROMPT}\n${WRITE_PROMPT}`

function verbs(): Map<string, Command> {
  return new Map(
    TRELLO_COMMANDS.filter((rc) => rc.name.startsWith('trello ')).map((rc) => [rc.name, rc]),
  )
}

// Each command line a prompt teaches, continuation lines joined.
function usageLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const stripped = (line.split('#')[0] ?? '').trim()
    if (stripped.startsWith('trello ')) lines.push(stripped)
    else if (lines.length > 0 && (stripped.startsWith('[') || stripped.startsWith('--'))) {
      lines.push(`${lines.pop() ?? ''} ${stripped}`)
    }
  }
  return lines
}

function nameOf(tokens: string[], known: Map<string, Command>): string | null {
  for (const k of [3, 4]) {
    const name = tokens.slice(0, k).join(' ')
    if (known.has(name)) return name
  }
  return null
}

function unmatched(line: string, known: Map<string, Command>): string[] {
  const tokens = line
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .split(/\s+/)
    .filter((t) => t !== '')
  const name = nameOf(tokens, known)
  const rc = name === null ? undefined : known.get(name)
  if (name === null || rc === undefined) return [`'${line}' names no registered command`]
  const longs = new Set(compileSpec(rc.spec).options.map((o) => o.names.at(-1)))
  const takesOperands =
    compileSpec(rc.spec).rest !== null || compileSpec(rc.spec).positional.length > 0
  const problems: string[] = []
  const rest = tokens.slice(name.split(' ').length)
  let i = 0
  while (i < rest.length) {
    const token = rest[i] ?? ''
    if (token.startsWith('--')) {
      if (!longs.has(token)) problems.push(`${name}: ${token} is not an option`)
      const next = rest[i + 1]
      i += next !== undefined && !next.startsWith('--') ? 2 : 1
      continue
    }
    if (!takesOperands) problems.push(`${name}: takes no operand, taught ${token}`)
    i += 1
  }
  return problems
}

// Mirrors python's tests/vfs/trello/test_prompt.py: the prompts are how an
// agent learns the verbs, so each line must name a registered command and
// only options its spec declares; the write verbs take every id as a flag,
// never a path operand.
describe('trello prompts', () => {
  it('every taught command line parses against its spec', () => {
    const known = verbs()
    expect(usageLines(TEXT).flatMap((line) => unmatched(line, known))).toEqual([])
  })

  it('teach every verb', () => {
    const known = verbs()
    const taught = new Set(usageLines(TEXT).map((line) => nameOf(line.split(/\s+/), known) ?? line))
    expect([...taught].sort()).toEqual([...known.keys()].sort())
  })
})

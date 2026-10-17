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
import { TRELLO } from '../../commands/cli/builtin/trello/index.ts'
import { compileSpec } from '../../commands/spec/compile.ts'
import type { CommandSpec } from '../../commands/spec/types.ts'
import { PROMPT, WRITE_PROMPT } from './prompt.ts'

const TEXT = `${PROMPT}\n${WRITE_PROMPT}`

function verbs(
  node: CommandSpec = TRELLO.spec,
  path: readonly string[] = [],
): Map<string, CommandSpec> {
  const here = [...path, node.name]
  if (node.subcommands.length === 0) return new Map([[here.join(' '), node]])
  return new Map(node.subcommands.flatMap((child) => [...verbs(child, here)]))
}

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

function nameOf(tokens: string[], known: Map<string, CommandSpec>): string | null {
  for (const k of [3, 4]) {
    const name = tokens.slice(0, k).join(' ')
    if (known.has(name)) return name
  }
  return null
}

function unmatched(line: string, known: Map<string, CommandSpec>): string[] {
  const tokens = line
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .split(/\s+/)
    .filter((t) => t !== '')
  const name = nameOf(tokens, known)
  const spec = name === null ? undefined : known.get(name)
  if (name === null || spec === undefined) return [`'${line}' names no trello command`]
  const compiled = compileSpec(spec)
  const longs = new Set(compiled.options.map((o) => o.names.at(-1)))
  const takesOperands = compiled.rest !== null || compiled.positional.length > 0
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

describe('trello prompts', () => {
  it('every taught command line parses against the CLI', () => {
    const known = verbs()
    const lines = usageLines(TEXT)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.flatMap((line) => unmatched(line, known))).toEqual([])
  })

  it('point at the CLI', () => {
    expect(PROMPT).toContain('trello --help')
    expect(WRITE_PROMPT).toContain('trello card create')
    expect(WRITE_PROMPT).toContain('trello card comment')
    expect(WRITE_PROMPT).toContain('trello --help')
  })
})

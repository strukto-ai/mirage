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
import { parseCommand, type ParsedArgs } from '../../../spec/parser.ts'
import { CommandSpec } from '../../../spec/types.ts'
import { flag, JQ, JSON as JSON_FIELDS, REPO, TEMPLATE } from './args.ts'

const SPEC = new CommandSpec({
  name: 'list',
  arguments: [
    REPO,
    JSON_FIELDS,
    JQ,
    TEMPLATE,
    flag({ short: '-d', long: '--draft', description: 'Filter by draft' }),
    flag({ short: '-s', long: '--stale' }),
    flag({ long: '--web' }),
  ],
})

function parse(...words: string[]): ParsedArgs {
  return parseCommand(SPEC, words, '/', 'gh')
}

describe('gh flags', () => {
  it('reads a bare flag as true', () => {
    expect(parse('--draft').flags).toEqual({ '--draft': true })
  })

  it('takes an attached value', () => {
    expect(parse('--draft=false').flags).toEqual({ '--draft': 'false' })
    expect(parse('--draft=true').flags).toEqual({ '--draft': 'true' })
  })

  it('never takes the next word as the value', () => {
    const parsed = parse('--draft', 'false')
    expect(parsed.flags).toEqual({ '--draft': true })
    expect(parsed.args.map(([word]) => word)).toEqual(['false'])
  })

  it('still clusters shorts', () => {
    expect(parse('-ds').flags).toEqual({ '--draft': true, '--stale': true })
  })

  it('needs no short', () => {
    expect(flag({ long: '--web' }).names).toEqual(['--web'])
    expect(parse('--web').flags).toEqual({ '--web': true })
  })

  it('carries the help line and the value name', () => {
    const built = flag({
      short: '-d',
      long: '--draft',
      description: 'Filter by draft',
      metavar: 'bool',
    })
    expect(built.names).toEqual(['-d', '--draft'])
    expect(built.help).toBe('Filter by draft')
    expect(built.metavar).toBe('bool')
  })

  it('gives the shared options a value', () => {
    expect(parse('-R', 'o/r', '--json', 'a,b', '-q', '.x', '-t', '{{.}}').flags).toEqual({
      '--repo': 'o/r',
      '--json': 'a,b',
      '--jq': '.x',
      '--template': '{{.}}',
    })
  })
})

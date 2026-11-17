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
import { SPECS } from '../../commands/spec/index.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { type AdmissionRules, AllowFlags, type Grammar } from '../types.ts'
import { allowPatterns, bind, patternReads, readPattern } from './grammar.ts'

function grammar(name: string): Grammar {
  const spec = SPECS[name]
  if (spec === undefined) throw new Error(`no spec for ${name}`)
  return { spec, tree: false, passthrough: false }
}

const RM = grammar('rm')

const GIT: Grammar = {
  spec: new CommandSpec({
    name: 'git',
    subcommands: [
      new CommandSpec({ name: 'log' }),
      new CommandSpec({
        name: 'push',
        arguments: [
          new Argument(['-f', '--force'], { action: 'store_true' }),
          new Argument(['remote'], { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'add',
        arguments: [
          new Argument(['-f', '--force'], { action: 'store_true' }),
          new Argument(['paths'], { nargs: '*' }),
        ],
      }),
    ],
  }),
  tree: true,
  passthrough: false,
}

function rules(over: Partial<AdmissionRules>): AdmissionRules {
  return { allow: null, ask: [], deny: [], ...over }
}

describe('readPattern', () => {
  it.each([
    [['rm', '-rf']],
    [['rm', '-fr']],
    [['rm', '-r', '-f']],
    [['rm', '-R', '--force']],
    [['rm', '--recursive', '--force']],
  ])('reads %j by canonical option names', (words) => {
    const read = readPattern(RM, words)
    expect(read?.path).toEqual(['rm'])
    expect(new Set(read?.flags.map((f) => f.name))).toEqual(new Set(['--recursive', '--force']))
  })

  it('keeps an option value, and a bare option matches any', () => {
    const head = grammar('head')
    expect(readPattern(head, ['head', '-n', '2'])?.flags).toEqual([
      { name: '--lines', values: ['2'] },
    ])
    expect(readPattern(head, ['head', '-n'])?.flags).toEqual([{ name: '--lines', values: [] }])
  })

  it('does not read a long option written by a prefix', () => {
    expect(readPattern(RM, ['rm', '--rec'])).toBeNull()
  })
})

describe('bind', () => {
  it("binds a subcommand * to the line's subcommand", () => {
    expect(bind(GIT, ['git', '*', '--force'], ['git', 'push'])).toEqual([
      ['git', 'push', '--force'],
      true,
    ])
    expect(bind(GIT, ['git', '*'], ['git'])).toBeNull()
    expect(bind(RM, ['rm', '*'], ['rm'])).toEqual([['rm', '*'], false])
  })
})

describe('patternReads', () => {
  it('reads a * pattern on a leaf without the option as null', () => {
    const r = rules({ deny: [{ reason: 'no', commands: ['git * --force'] }] })
    expect(new Map(patternReads(r, ['git', 'log'], GIT))).toEqual(
      new Map([['git * --force', null]]),
    )
    expect(new Map(patternReads(r, ['git', 'add'], GIT)).get('git * --force')?.path).toEqual([
      'git',
      'add',
    ])
  })

  it('leaves a pattern the grammar refuses to word matching', () => {
    const r = rules({ deny: [{ reason: 'no', commands: ['rm --rec', 'rm -f'] }] })
    const reads = new Map(patternReads(r, ['rm'], RM))
    expect(reads.has('rm --rec')).toBe(false)
    expect(reads.get('rm -f')).not.toBeNull()
  })
})

describe('allowPatterns', () => {
  it('expands groups and joins a flag set', () => {
    expect(
      allowPatterns(rules({ allow: ['gh pr {view,diff}', new AllowFlags('rm', ['-f', '-v'])] })),
    ).toEqual(['gh pr view', 'gh pr diff', 'rm -f -v'])
  })
})

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
import { BUILTIN_SPECS, helpSpec, isBuiltinGrammar, registeredSpec, specOf } from './builtins.ts'
import { HELP_OPTION, VERSION_OPTION } from './constants.ts'
import { CommandSpec, Operand, Option } from './types.ts'

describe('BUILTIN_SPECS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(BUILTIN_SPECS)).toBe(true)
  })

  it('contains the core file commands', () => {
    for (const name of ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'cut', 'file']) {
      expect(BUILTIN_SPECS[name], `missing spec: ${name}`).toBeDefined()
    }
  })

  it('ls takes PATH rest args', () => {
    const spec = BUILTIN_SPECS.ls
    expect(spec?.rest?.type).toBe('path')
  })

  it('grep has a TEXT positional arg followed by PATH rest', () => {
    const spec = BUILTIN_SPECS.grep
    expect(spec?.positional[0]?.type).toBe('str')
    expect(spec?.rest?.type).toBe('path')
  })

  it('head recognizes -n and -c as TEXT-valued flags', () => {
    const spec = BUILTIN_SPECS.head
    const n = spec?.options.find((o) => o.short === '-n')
    const c = spec?.options.find((o) => o.short === '-c')
    expect(n?.type).toBe('str')
    expect(c?.type).toBe('str')
  })

  it('echo has -n and -e boolean flags and TEXT rest', () => {
    const spec = BUILTIN_SPECS.echo
    expect(spec?.rest?.type).toBe('str')
    const n = spec?.options.find((o) => o.short === '-n')
    const e = spec?.options.find((o) => o.short === '-e')
    expect(n?.type).toBe('bool')
    expect(e?.type).toBe('bool')
  })

  it('du has a long --max-depth flag with TEXT value', () => {
    const spec = BUILTIN_SPECS.du
    const maxDepth = spec?.options.find((o) => o.long === '--max-depth')
    expect(maxDepth?.type).toBe('str')
  })

  it('covers the full python set size', () => {
    expect(Object.keys(BUILTIN_SPECS).length).toBe(95)
  })
})

// Mirrors test_builtin_specs.py.
describe('helpSpec / registeredSpec / isBuiltinGrammar', () => {
  it('appends the two standard options', () => {
    const spec = new CommandSpec({ rest: new Operand({ type: 'str' }) })
    const enriched = helpSpec(spec)
    expect(enriched.options).toEqual([HELP_OPTION, VERSION_OPTION])
    expect(enriched.rest).toBe(spec.rest)
  })

  it('leaves a declared option alone', () => {
    const own = new Option({ long: '--version', description: 'mine' })
    expect(helpSpec(new CommandSpec({ options: [own] })).options).toEqual([own, HELP_OPTION])
  })

  it('returns the same spec when both are declared', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--help' }), new Option({ long: '--version' })],
    })
    expect(helpSpec(spec)).toBe(spec)
  })

  // One enriched object per builtin, not one per backend that registers the
  // command, which is what makes isBuiltinGrammar a pointer compare.
  it('shares one registered copy per builtin', () => {
    const first = registeredSpec('tee', specOf('tee'))
    expect(first).toBe(registeredSpec('tee', specOf('tee')))
    expect(first).not.toBe(BUILTIN_SPECS.tee)
  })

  it('builds a fresh copy for a custom spec', () => {
    const spec = new CommandSpec({ rest: new Operand({ type: 'str' }) })
    expect(registeredSpec('tee', spec)).not.toBe(registeredSpec('tee', spec))
  })

  it('recognizes a builtin grammar declared or registered', () => {
    const expr = specOf('expr')
    expect(isBuiltinGrammar('expr', expr)).toBe(true)
    expect(isBuiltinGrammar('expr', registeredSpec('expr', expr))).toBe(true)
  })

  // The whole point: a name is not an identity. A mount may register a
  // command under a builtin's name and nothing refuses it, so the measured
  // per-program rules must not follow the name.
  it('does not take a borrowed name for the builtin grammar', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--mode', type: 'str' })],
      rest: new Operand({ type: 'str' }),
    })
    expect(isBuiltinGrammar('expr', spec)).toBe(false)
    expect(isBuiltinGrammar('expr', registeredSpec('expr', spec))).toBe(false)
    // A spec that reproduces expr's field for field is still its own object.
    const twin = new CommandSpec({
      description: specOf('expr').description,
      rest: new Operand({ type: 'str' }),
    })
    expect(twin).toEqual(BUILTIN_SPECS.expr)
    expect(isBuiltinGrammar('expr', twin)).toBe(false)
  })

  it('never takes an unknown name for a builtin grammar', () => {
    expect(isBuiltinGrammar('nope', new CommandSpec())).toBe(false)
    expect(isBuiltinGrammar('expr', null)).toBe(false)
  })
})

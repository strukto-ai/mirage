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
import { compileSpec } from './compile.ts'
import { Argument, CommandSpec } from './types.ts'

describe('Argument', () => {
  it('copies and freezes all nested declarations', () => {
    const names = ['-e', '--expression']
    const choices = ['a']
    const providedBy = ['--expression']
    const textWhen = ['--args']
    const option = new Argument(names, { choices })
    const operand = new Argument('file', { type: 'path', providedBy, textWhen })
    names.push('--other')
    choices.push('b')
    providedBy.push('--file')
    textWhen.push('--raw-input')
    expect(option.names).toEqual(['-e', '--expression'])
    expect(option.choices).toEqual(['a'])
    expect(operand.providedBy).toEqual(['--expression'])
    expect(operand.textWhen).toEqual(['--args'])
    expect(Object.isFrozen(option)).toBe(true)
    expect(() => (option.names as string[]).push('--later')).toThrow()
    expect(() => (option.choices as string[]).push('c')).toThrow()
    expect(() => (operand.providedBy as string[]).push('--later')).toThrow()
    expect(() => (operand.textWhen as string[]).push('--later')).toThrow()
  })
})

describe('CommandSpec', () => {
  it('owns immutable argument, child, alias and ignore-token collections', () => {
    const argument = new Argument('--mode')
    const args = [argument]
    const child = new CommandSpec({ name: 'status' })
    const children = [child]
    const aliases = ['st']
    const ignoreTokens = ['!']
    const spec = new CommandSpec({ arguments: args, subcommands: children, aliases, ignoreTokens })
    const compiled = compileSpec(spec)
    args.push(new Argument('--later'))
    children.push(new CommandSpec({ name: 'other' }))
    aliases.push('other')
    ignoreTokens.push('?')
    expect(spec.arguments).toEqual([argument])
    expect(spec.subcommands).toEqual([child])
    expect(spec.aliases).toEqual(['st'])
    expect([...spec.ignoreTokens]).toEqual(['!'])
    expect(() => (spec.arguments as Argument[]).push(argument)).toThrow()
    expect(() => (spec.subcommands as CommandSpec[]).push(child)).toThrow()
    expect(() => (spec.aliases as string[]).push('later')).toThrow()
    expect(() => (spec.ignoreTokens as Set<string>).add('?')).toThrow()
    expect(compileSpec(spec)).toBe(compiled)
  })
})

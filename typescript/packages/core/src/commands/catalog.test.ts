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
import { CommandCatalog, RegisteredCommand } from './config.ts'
import { CommandSpec } from './spec/types.ts'
import { S3_COMMANDS } from './builtin/s3/index.ts'

const SPEC = new CommandSpec()
const FN = () => Promise.resolve([null, { exitCode: 0 } as never] as [null, never])
const REPLACEMENT_FN = () => Promise.resolve([null, { exitCode: 1 } as never] as [null, never])
const PROVISION = () => null

function registered(name: string, filetype: string | null = null): RegisteredCommand {
  return new RegisteredCommand({ name, spec: SPEC, vfs: 's3', filetype, fn: FN })
}

describe('CommandCatalog', () => {
  it('remains iterable and resolves name plus filetype', () => {
    const cat = registered('cat')
    const rendered = registered('cat', '.demo')
    const catalog = new CommandCatalog([cat, rendered])

    expect([...catalog]).toEqual([cat, rendered])
    expect(catalog.length).toBe(2)
    expect(catalog[0]).toBe(cat)
    expect(catalog.map((command) => command.filetype)).toEqual([null, '.demo'])
    expect(catalog.find((command) => command.filetype === '.demo')).toBe(rendered)
    expect(catalog.require('cat')).toBe(cat)
    expect(catalog.require('cat', '.demo')).toBe(rendered)
  })

  it('remains assignable to readonly command-array consumers', () => {
    const names = (commands: readonly RegisteredCommand[]) => commands.map(({ name }) => name)

    expect(names(new CommandCatalog([registered('cat')]))).toEqual(['cat'])
  })

  it('has explicit optional and required missing behavior', () => {
    const catalog = new CommandCatalog([registered('cat')])

    expect(catalog.get('missing')).toBeNull()
    expect(() => catalog.require('missing')).toThrow(/missing/)
  })

  it('exposes only an immutable command array', () => {
    const catalog = new CommandCatalog([registered('cat')])

    expect(catalog.size).toBe(1)
    expect(Object.isFrozen(catalog.toArray())).toBe(true)
    expect(() => (catalog.toArray() as RegisteredCommand[]).push(registered('tail'))).toThrow()
  })
})

describe('RegisteredCommand.withOverrides', () => {
  it('keeps command definitions immutable', () => {
    const original = registered('cat')

    expect(Object.isFrozen(original)).toBe(true)
    expect(() => ((original as unknown as { name: string }).name = 'tail')).toThrow()
  })

  it('returns an independent definition', () => {
    const original = registered('cat')

    const changed = original.withOverrides({ fn: REPLACEMENT_FN, provision: PROVISION })

    expect(changed).not.toBe(original)
    expect(changed.fn).toBe(REPLACEMENT_FN)
    expect(changed.provisionFn).toBe(PROVISION)
    expect(original.fn).toBe(FN)
    expect(original.provisionFn).toBeNull()
  })

  it('can clear a provision', () => {
    const original = new RegisteredCommand({
      name: 'cat',
      spec: SPEC,
      vfs: 's3',
      fn: FN,
      provisionFn: PROVISION,
    })

    const changed = original.withOverrides({ provision: null })

    expect(changed.provisionFn).toBeNull()
    expect(original.provisionFn).toBe(PROVISION)
  })
})

it('S3 commands expose static lookup', () => {
  const cat = S3_COMMANDS.require('cat')

  expect(cat.name).toBe('cat')
  expect(cat.vfs).toBe('s3')
  expect(cat.filetype).toBeNull()
})

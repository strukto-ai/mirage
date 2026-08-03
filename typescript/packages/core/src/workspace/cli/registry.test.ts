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

import { z } from 'zod'

import { CLISpec, type CLIConfigModel } from '../../commands/cli/types.ts'
import { IOResult } from '../../io/types.ts'
import { CLIRegistry } from './registry.ts'

// Mirrors python/tests/workspace/cli/test_registry.py.

interface TokenConfig {
  token: string
}

function tokenConfig(input: Record<string, unknown>): TokenConfig {
  const keys = Object.keys(input).filter((k) => k !== 'token')
  if (keys.length > 0) throw new Error(`unknown config keys: ${keys.sort().join(', ')}`)
  if (typeof input.token !== 'string') throw new Error('token is required')
  return { token: input.token }
}

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

function tree(configModel: CLIConfigModel | null = null): CLISpec {
  return new CLISpec({
    name: 'prog',
    configModel,
    subcommands: [new CLISpec({ name: 'run', fn: noop })],
  })
}

describe('CLIRegistry', () => {
  it('installs, gets, and snapshots', () => {
    const reg = new CLIRegistry()
    const install = reg.install('prog', tree())
    expect(reg.get('prog')).toBe(install)
    expect(reg.get('other')).toBeNull()
    expect([...reg.items().keys()]).toEqual(['prog'])
  })

  it('two installs of one spec hold their own configs', () => {
    const reg = new CLIRegistry()
    const spec = tree(tokenConfig)
    const eng = reg.install('prog', spec, { token: 'eng' })
    const sup = reg.install('prog-sup', spec, { token: 'sup' })
    expect((eng.config as TokenConfig).token).toBe('eng')
    expect((sup.config as TokenConfig).token).toBe('sup')
  })

  it('requires a single-word name', () => {
    const reg = new CLIRegistry()
    expect(() => reg.install('two words', tree())).toThrow(/single word/)
    expect(() => reg.install('', tree())).toThrow(/single word/)
  })

  it('refuses a duplicate name', () => {
    const reg = new CLIRegistry()
    reg.install('prog', tree())
    expect(() => reg.install('prog', tree())).toThrow(/already installed/)
  })

  it('refuses shell builtin collisions', () => {
    const reg = new CLIRegistry()
    expect(() => reg.install('cd', tree())).toThrow(/shell builtin/)
    expect(() => reg.install('kill', tree())).toThrow(/shell builtin/)
  })

  it('refuses general command collisions', () => {
    const reg = new CLIRegistry()
    expect(() => reg.install('grep', tree())).toThrow(/general command/)
    expect(() => reg.install('ln', tree())).toThrow(/general command/)
  })

  it('validates config through the model, fail loud', () => {
    const reg = new CLIRegistry()
    expect(() => reg.install('prog', tree(tokenConfig), {})).toThrow(/token is required/)
    expect(() => reg.install('prog', tree(tokenConfig), { token: 'x', extra: 1 })).toThrow(
      /unknown config keys: extra/,
    )
  })

  it('refuses config without a model', () => {
    const reg = new CLIRegistry()
    expect(() => reg.install('prog', tree(), { token: 'x' })).toThrow(/declares no configModel/)
  })

  it('installs with null config when neither is given', () => {
    const reg = new CLIRegistry()
    expect(reg.install('prog', tree()).config).toBeNull()
  })

  it('uninstall removes and unknown throws', () => {
    const reg = new CLIRegistry()
    reg.install('prog', tree())
    reg.uninstall('prog')
    expect(reg.get('prog')).toBeNull()
    expect(() => {
      reg.uninstall('prog')
    }).toThrow(/not installed/)
  })
})

describe('CLIRegistry zod config schemas', () => {
  it('rejects unknown keys on a plain object schema', () => {
    const reg = new CLIRegistry()
    expect(() =>
      reg.install('prog', tree(z.object({ token: z.string() })), { token: 'x', typo: 'y' }),
    ).toThrow(/unknown config keys: typo/)
  })

  it('honors a loose schema that allows extra keys', () => {
    const reg = new CLIRegistry()
    const install = reg.install('prog', tree(z.looseObject({ token: z.string() })), {
      token: 'x',
      extra: 'y',
    })
    expect(install.config).toEqual({ token: 'x', extra: 'y' })
  })

  it('lets a strict schema enforce its own unknown-key error', () => {
    const reg = new CLIRegistry()
    expect(() =>
      reg.install('prog', tree(z.strictObject({ token: z.string() })), { token: 'x', typo: 'y' }),
    ).toThrow(/Unrecognized key/)
  })

  it('refuses a normalizer that returns a non-object', () => {
    const reg = new CLIRegistry()
    expect(() =>
      reg.install(
        'prog',
        tree(() => 'primitive'),
        {},
      ),
    ).toThrow(/must return an object or null/)
  })
})

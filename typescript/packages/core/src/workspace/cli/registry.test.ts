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
import { DISCORD } from '../../commands/cli/builtin/discord/index.ts'
import { GIT } from '../../commands/cli/builtin/git/index.ts'
import { GWS } from '../../commands/cli/builtin/gws/index.ts'
import { LINEAR } from '../../commands/cli/builtin/linear/index.ts'
import { NTN } from '../../commands/cli/builtin/ntn/index.ts'
import { SLACK } from '../../commands/cli/builtin/slack/index.ts'
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

  it('refuses a shell keyword', () => {
    // The parser consumes a reserved word, so the install would never be
    // reachable from a line.
    const reg = new CLIRegistry()
    expect(() => reg.install('if', tree())).toThrow(/shell keyword/)
    expect(() => reg.install('select', tree())).toThrow(/shell keyword/)
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

  // The same snake_case YAML config block must serve the Python and TS
  // sides alike (the resource registries already promise this); the
  // pydantic arm is snake_case-native, so the zod arm normalizes.
  it('accepts python-style snake_case keys for camelCase fields', () => {
    const reg = new CLIRegistry()
    const model = z.object({ imapHost: z.string(), imapPort: z.number().default(993) })
    const install = reg.install('prog', tree(model), {
      imap_host: 'mail.example.com',
      imap_port: 143,
    })
    expect(install.config).toEqual({ imapHost: 'mail.example.com', imapPort: 143 })
  })

  it('reports an unknown key in the spelling the caller used', () => {
    const reg = new CLIRegistry()
    const model = z.object({ imapHost: z.string() })
    expect(() => reg.install('prog', tree(model), { imap_host: 'x', imap_hostt: 'y' })).toThrow(
      /unknown config keys: imap_hostt/,
    )
  })

  it('rejects both spellings of one field', () => {
    const reg = new CLIRegistry()
    const model = z.object({ imapHost: z.string() })
    expect(() => reg.install('prog', tree(model), { imap_host: 'x', imapHost: 'y' })).toThrow(
      /duplicates field 'imapHost'/,
    )
  })

  it('does not read prototype members as declared fields', () => {
    const reg = new CLIRegistry()
    const model = z.object({ token: z.string() })
    expect(() => reg.install('prog', tree(model), { token: 'x', constructor: 'y' })).toThrow(
      /unknown config keys: constructor/,
    )
  })

  it('keeps undeclared keys verbatim under a loose schema', () => {
    const reg = new CLIRegistry()
    const install = reg.install('prog', tree(z.looseObject({ imapHost: z.string() })), {
      imap_host: 'x',
      extra_key: 'y',
    })
    expect(install.config).toEqual({ imapHost: 'x', extra_key: 'y' })
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
    ).toThrow(/^CLI 'prog': typo: unrecognized_keys$/)
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

// The per-CLI cases above use hand-written schemas, which cannot notice a
// real builtin declaring a field no snake_case spelling reaches (an
// acronym like `baseURL` camelizes from `base_url` as `baseUrl`). This
// walks the shipped specs instead, so a CLI added later is covered
// without editing the mechanism's tests.
const BUILTIN_CLIS: readonly (readonly [string, CLISpec])[] = [
  ['gws', GWS],
  ['slack', SLACK],
  ['discord', DISCORD],
  ['ntn', NTN],
  ['linear', LINEAR],
  ['git', GIT],
]

const SAMPLES: readonly unknown[] = ['x', 1, true, ['x']]

// Capital runs collapse to one word (baseURL -> base_url), because that
// is the spelling a Python config writer uses; per-capital splitting
// (base_u_r_l) would round-trip onto the acronym field and hide it.
function snakeOf(field: string): string {
  return field.replace(/[A-Z]+/g, (run) => `_${run.toLowerCase()}`)
}

function sampleFor(schema: z.ZodType): unknown {
  for (const value of SAMPLES) {
    if (schema.safeParse(value).success) return value
  }
  throw new Error('no sample value satisfies this field')
}

describe('builtin CLI configs install from the python spelling', () => {
  for (const [name, spec] of BUILTIN_CLIS) {
    const model = spec.configModel
    if (!(model instanceof z.ZodObject)) continue
    it(`${name} accepts every declared field as snake_case`, () => {
      const fields = Object.keys(model.shape).filter((f) => f !== 'refreshFn')
      const config: Record<string, unknown> = {}
      for (const field of fields) {
        config[snakeOf(field)] = sampleFor(model.shape[field] as z.ZodType)
      }
      const install = new CLIRegistry().install(name, spec, config)
      expect(Object.keys(install.config as Record<string, unknown>).sort()).toEqual(fields.sort())
    })
  }
})

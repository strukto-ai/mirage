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

import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SecretSourceSchema } from './config.ts'
import { SecretsError } from './errors.ts'
import { fetchSecret, registerSecrets } from './registry.ts'
import {
  configValue,
  isConfigPointer,
  resolveConfigSecrets,
  resolveSources,
  resolveSourcesFor,
} from './sources.ts'
import type { ResolvedSecret, ResolvedSource } from './types.ts'

const DemoConfig = z.strictObject({
  account: z.string().default('default'),
  token: z.string().optional(),
})
type DemoConfig = z.infer<typeof DemoConfig>

function fetchDemo(config: DemoConfig, _ref: string): Promise<ResolvedSecret> {
  return Promise.resolve({ fields: { credential: `${config.account}:${config.token ?? 'none'}` } })
}

function block(config: Record<string, unknown>): ReturnType<typeof SecretSourceSchema.parse> {
  return SecretSourceSchema.parse({ source: 'demo-sources', config })
}

function instance(built: Record<string, ResolvedSource>, name: string): ResolvedSource {
  const entry = built[name]
  if (entry === undefined) throw new Error(`no instance ${name}`)
  return entry
}

// `env` is a node-package builtin, and core registers no builtins at
// all, so the bootstrap source the pointers read is stood up here. It
// answers the way node's own does, with the process environment as one
// secret's fields.
const EnvConfig = z.strictObject({})

// Registered over `dotenv` for one test: a bootstrap source whose
// failure carries words the agent must never read, which is what the
// real dotenv source does with the host path it looked for.
const DeadConfig = z.strictObject({})

describe('resolveSources', () => {
  beforeEach(() => {
    registerSecrets('demo-sources', DemoConfig, fetchDemo)
    registerSecrets('env', EnvConfig, () =>
      Promise.resolve({ fields: { ...process.env } as Record<string, string> }),
    )
  })

  it('takes a raw declaration, not only a parsed one', async () => {
    // The config door and a clone override hand over what they were
    // given; only the constructor parses eagerly.
    const built = await resolveSources({
      prod: { source: 'demo-sources', config: { account: 'raw' } },
    })
    const prod = instance(built, 'prod')
    const secret = await prod.fetch(prod.config as never, 'r')
    expect(secret.fields.credential).toBe('raw:none')
  })

  it('carries a literal config to the source', async () => {
    const built = await resolveSources({ prod: block({ account: 'acct' }) })
    const prod = instance(built, 'prod')
    const secret = await prod.fetch(prod.config as never, 'r')
    expect(secret.fields.credential).toBe('acct:none')
  })

  it('reads a pointer config from its bootstrap source', async () => {
    process.env.SOURCES_PROBE = 's3cr3t'
    try {
      const built = await resolveSources({
        prod: block({ token: { from: 'env', key: 'SOURCES_PROBE' } }),
      })
      const prod = instance(built, 'prod')
      const secret = await prod.fetch(prod.config as never, 'r')
      expect(secret.fields.credential).toBe('default:s3cr3t')
    } finally {
      delete process.env.SOURCES_PROBE
    }
  })

  it('keeps two instances of one source apart', async () => {
    const built = await resolveSources({
      prod: block({ account: 'acct-prod' }),
      test: block({ account: 'acct-test' }),
    })
    const first = instance(built, 'prod')
    const second = instance(built, 'test')
    const prod = await first.fetch(first.config as never, 'r')
    const test = await second.fetch(second.config as never, 'r')
    expect(prod.fields.credential).toBe('acct-prod:none')
    expect(test.fields.credential).toBe('acct-test:none')
  })

  it('resolves an empty table to nothing', async () => {
    expect(await resolveSources({})).toEqual({})
  })

  it('names the field a missing bootstrap value wanted', async () => {
    delete process.env.SOURCES_ABSENT
    await expect(
      resolveSources({ prod: block({ token: { from: 'env', key: 'SOURCES_ABSENT' } }) }),
    ).rejects.toThrowError(/secrets\.prod\.config\.token.*SOURCES_ABSENT/s)
  })

  it('names the known sources for an unknown one', async () => {
    await expect(
      resolveSources({ prod: SecretSourceSchema.parse({ source: 'nope' }) }),
    ).rejects.toThrowError(SecretsError)
  })

  it('reports field and reason for config the source refuses', async () => {
    await expect(resolveSources({ prod: block({ nonesuch: 'x' }) })).rejects.toThrowError(
      /secrets\.prod:.*nonesuch/s,
    )
  })

  it('never carries the value into a refusal', async () => {
    process.env.SOURCES_PROBE = 's3cr3t'
    try {
      const caught = await resolveSources({
        prod: block({ account: { from: 'env', key: 'SOURCES_PROBE' }, nonesuch: 'x' }),
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(String(caught)).toContain('secrets.prod')
      expect(String(caught)).not.toContain('s3cr3t')
    } finally {
      delete process.env.SOURCES_PROBE
    }
  })

  it('configValue reads one field', async () => {
    process.env.SOURCES_PROBE = 'v'
    try {
      const ref = block({ token: { from: 'env', key: 'SOURCES_PROBE' } }).config.token
      expect(await configValue('secrets.prod.config.token', ref as never, new Map())).toBe('v')
    } finally {
      delete process.env.SOURCES_PROBE
    }
  })

  it('keeps a __proto__ instance as an own entry', async () => {
    // Both the input and the output have to be built with
    // fromEntries: a keyed object literal assigns through the
    // prototype setter and leaves no own property, so the lookup
    // would miss an instance python's dict takes like any other.
    const blocks = Object.fromEntries([['__proto__', block({ account: 'weird' })]])
    const built = await resolveSources(blocks)
    expect(Object.hasOwn(built, '__proto__')).toBe(true)
    const secret = await fetchSecret('__proto__', '', built)
    expect(secret.fields.credential).toBe('weird:none')
  })

  it('reports the issue code, not the words a refinement chose', async () => {
    // A custom source's own refinement may spell the rejected input,
    // and the value it rejects is the credential just fetched.
    const LoudConfig = z.strictObject({
      token: z.string().refine(() => false, { message: 'bad token' }),
    })
    registerSecrets('loud-sources', LoudConfig, () => Promise.resolve({ fields: {} }))
    process.env.SOURCES_LOUD = 's3cr3t-value'
    try {
      const caught = await resolveSources({
        prod: SecretSourceSchema.parse({
          source: 'loud-sources',
          config: { token: { from: 'env', key: 'SOURCES_LOUD' } },
        }),
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(String(caught)).toContain('secrets.prod: token: custom')
      expect(String(caught)).not.toContain('s3cr3t-value')
    } finally {
      delete process.env.SOURCES_LOUD
    }
  })

  it('fetches one bootstrap secret once', async () => {
    // Two fields naming one dotenv file must read one generation of
    // it; a rotation between them would pin a mismatched pair.
    const calls: string[] = []
    registerSecrets('dotenv', DeadConfig, (_config: unknown, ref: string) => {
      calls.push(ref)
      return Promise.resolve({ fields: { A: 'a', B: 'b' } })
    })
    const built = await resolveSources({
      prod: SecretSourceSchema.parse({
        source: 'demo-sources',
        config: {
          account: { from: 'dotenv', ref: '/one/file', key: 'A' },
          token: { from: 'dotenv', ref: '/one/file', key: 'B' },
        },
      }),
    })
    expect(calls).toEqual(['/one/file'])
    const entry = instance(built, 'prod')
    expect((await entry.fetch(entry.config as never, '')).fields.credential).toBe('a:b')
  })

  it('redacts a refinement that throws instead of failing', async () => {
    // safeParse does not catch what a refinement throws, so it never
    // becomes an issue list; the words are over a value just fetched.
    const ThrowingConfig = z.strictObject({
      token: z.string().refine(() => {
        throw new Error('bad token s3cr3t-value')
      }),
    })
    registerSecrets('throwing-sources', ThrowingConfig, () => Promise.resolve({ fields: {} }))
    process.env.SOURCES_THROWN = 's3cr3t-value'
    try {
      const caught = await resolveSources({
        prod: SecretSourceSchema.parse({
          source: 'throwing-sources',
          config: { token: { from: 'env', key: 'SOURCES_THROWN' } },
        }),
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(String(caught)).toContain('secrets.prod: config refused')
      expect(String(caught)).not.toContain('s3cr3t-value')
    } finally {
      delete process.env.SOURCES_THROWN
    }
  })

  it('reports a bootstrap field named after a prototype member absent', async () => {
    registerSecrets('dotenv', DeadConfig, () => Promise.resolve({ fields: { A: 'a' } }))
    const caught = await resolveSources({
      prod: SecretSourceSchema.parse({
        source: 'demo-sources',
        config: { token: { from: 'dotenv', ref: '/f', key: 'constructor' } },
      }),
    }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(String(caught)).toContain("wanted field 'constructor'")
  })

  it('redacts a failed bootstrap fetch', async () => {
    registerSecrets('dotenv', DeadConfig, () =>
      Promise.reject(new SecretsError('dotenv file not found: /host/only/.env')),
    )
    const caught = await resolveSources({
      prod: SecretSourceSchema.parse({
        source: 'demo-sources',
        config: { token: { from: 'dotenv', ref: '/host/only/.env', key: 'TOKEN' } },
      }),
    }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(caught).toBeInstanceOf(SecretsError)
    expect(String(caught)).toContain('secrets.prod.config.token: cannot fetch from dotenv')
    expect(String(caught)).not.toContain('/host/only/.env')
  })
})

describe('isConfigPointer', () => {
  it('accepts the three-key grammar', () => {
    expect(isConfigPointer({ from: 'env', ref: 'r', key: 'K' })).toBe(true)
    expect(isConfigPointer({ from: 'env', key: 'K' })).toBe(true)
  })

  it('rejects an ordinary object that merely carries a `from`', () => {
    // Strict on purpose: python narrows the same set by validating it
    // as `SecretRef`, extra keys included.
    expect(isConfigPointer({ from: 'a@b.com', to: 'c@d.com', subject: 'hi' })).toBe(false)
  })

  it('rejects a plain value, an array and null', () => {
    expect(isConfigPointer('xoxb-literal')).toBe(false)
    expect(isConfigPointer([{ from: 'env', key: 'K' }])).toBe(false)
    expect(isConfigPointer(null)).toBe(false)
  })
})

describe('resolveConfigSecrets', () => {
  beforeEach(() => {
    process.env.CONFIG_SECRETS_PROBE = 'xoxb-fetched'
  })

  it('substitutes the fetched secret and keeps every literal', async () => {
    registerSecrets('env', EnvConfig, (_c: unknown, _r: string) =>
      Promise.resolve({ fields: { CONFIG_SECRETS_PROBE: 'xoxb-fetched' } }),
    )
    const out = await resolveConfigSecrets({
      token: { from: 'env', key: 'CONFIG_SECRETS_PROBE' },
      baseUrl: 'https://slack.com/api',
    })
    expect(out).toEqual({ token: 'xoxb-fetched', baseUrl: 'https://slack.com/api' })
  })

  it('leaves a config with no pointer alone', async () => {
    expect(await resolveConfigSecrets({ token: 'xoxb-literal' })).toEqual({
      token: 'xoxb-literal',
    })
  })

  it('recurses into a nested object', async () => {
    registerSecrets('env', EnvConfig, (_c: unknown, _r: string) =>
      Promise.resolve({ fields: { CONFIG_SECRETS_PROBE: 'xoxb-fetched' } }),
    )
    const out = await resolveConfigSecrets({
      inner: { token: { from: 'env', key: 'CONFIG_SECRETS_PROBE' } },
      n: 1,
    })
    expect(out).toEqual({ inner: { token: 'xoxb-fetched' }, n: 1 })
  })

  it('leaves a class instance whole', async () => {
    // A config field may hold a live object: rebuilding it from its
    // own entries drops the methods the resource then calls.
    class AuthProvider {
      readonly kind = 'oauth'
      tokens(): string {
        return 'from-the-provider'
      }
    }
    const provider = new AuthProvider()
    const out = await resolveConfigSecrets({ authProvider: provider })
    expect(out.authProvider).toBe(provider)
    expect((out.authProvider as AuthProvider).tokens()).toBe('from-the-provider')
  })

  it('leaves an instance carrying a `from` alone', async () => {
    class Named {
      readonly from = 'env'
      readonly key = 'CONFIG_SECRETS_PROBE'
    }
    const named = new Named()
    expect(isConfigPointer(named)).toBe(false)
    const out = await resolveConfigSecrets({ authProvider: named })
    expect(out.authProvider).toBe(named)
  })

  it('labels an error with the config field path', async () => {
    registerSecrets('env', EnvConfig, (_c: unknown, _r: string) =>
      Promise.resolve({ fields: { OTHER: 'x' } }),
    )
    const failing = resolveConfigSecrets(
      { token: { from: 'env', key: 'CONFIG_SECRETS_PROBE' } },
      undefined,
      'mounts./slack.config',
    )
    await expect(failing).rejects.toThrow("mounts./slack.config.token: wanted field 'CONFIG")
  })
})

describe('resolveSourcesFor', () => {
  beforeEach(() => {
    registerSecrets('demo-sources', DemoConfig, fetchDemo)
    registerSecrets('env', EnvConfig, () =>
      Promise.resolve({ fields: { ...process.env } as Record<string, string> }),
    )
    delete process.env.SOURCES_FOR_ABSENT
  })

  // A declaration whose own config points at a bootstrap value that is
  // not there, so building it fails.
  function brokenBootstrap(): Record<string, unknown> {
    return {
      prod: {
        source: 'demo-sources',
        config: { account: { from: 'env', key: 'SOURCES_FOR_ABSENT' } },
      },
    }
  }
  const pointer = { from: 'prod', ref: 'r', key: 'credential' }

  it('builds nothing when no config points', async () => {
    // Building a source reads its bootstrap pointers, and a dotenv file
    // is I/O; a door whose configs hold no pointer must not pay it, or
    // a momentarily unreadable file fails a workspace that never
    // needed the source.
    expect(await resolveSourcesFor(brokenBootstrap(), [{ token: 'literal' }, {}])).toBeUndefined()
  })

  it('builds when a config points', async () => {
    await expect(resolveSourcesFor(brokenBootstrap(), [{ token: pointer }])).rejects.toThrow(
      'secrets.prod.config.account',
    )
    const built = await resolveSourcesFor(
      { prod: { source: 'demo-sources', config: { account: 'a1' } } },
      [{ inner: [{ token: pointer }] }],
    )
    expect(instance(built ?? {}, 'prod').source).toBe('demo-sources')
  })

  it('leaves a bad container to the constructor', async () => {
    expect(await resolveSourcesFor(undefined, [{ token: pointer }])).toBeUndefined()
    expect(await resolveSourcesFor(null, [{ token: pointer }])).toBeUndefined()
    expect(await resolveSourcesFor({}, [{ token: pointer }])).toBeUndefined()
    // A list from an untyped REST override is not a mapping; the
    // constructor refuses it with the wording every door shares.
    expect(await resolveSourcesFor([brokenBootstrap()], [{ token: pointer }])).toBeUndefined()
  })
})

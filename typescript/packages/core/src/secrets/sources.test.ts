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

import { SourceBlockSchema } from './config.ts'
import { SecretsError } from './errors.ts'
import { fetchSecret, registerSecrets } from './registry.ts'
import { configValue, resolveSources } from './sources.ts'
import type { ResolvedSecret, ResolvedSource } from './types.ts'

const DemoConfig = z.strictObject({
  account: z.string().default('default'),
  token: z.string().optional(),
})
type DemoConfig = z.infer<typeof DemoConfig>

function fetchDemo(config: DemoConfig, _ref: string): Promise<ResolvedSecret> {
  return Promise.resolve({ fields: { credential: `${config.account}:${config.token ?? 'none'}` } })
}

function block(config: Record<string, unknown>): ReturnType<typeof SourceBlockSchema.parse> {
  return SourceBlockSchema.parse({ source: 'demo-sources', config })
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
      resolveSources({ prod: SourceBlockSchema.parse({ source: 'nope' }) }),
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
      expect(await configValue('prod', 'token', ref as never, new Map())).toBe('v')
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
        prod: SourceBlockSchema.parse({
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
      prod: SourceBlockSchema.parse({
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
        prod: SourceBlockSchema.parse({
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
      prod: SourceBlockSchema.parse({
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
      prod: SourceBlockSchema.parse({
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

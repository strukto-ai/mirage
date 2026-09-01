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

import { SecretsError } from './errors.ts'
import { fetchSecret, knownSources, registerSecrets, sourceFor } from './registry.ts'
import type { ResolvedSecret, ResolvedSource } from './types.ts'

const VaultConfig = z.strictObject({ host: z.string().default('local') })
type VaultConfig = z.infer<typeof VaultConfig>

describe('secrets registry', () => {
  it('resolves a custom registration', () => {
    const fetch = (_config: VaultConfig, _ref: string): Promise<ResolvedSecret> =>
      Promise.resolve({ fields: { token: 't' } })
    registerSecrets('vault-resolves', VaultConfig, fetch)
    const entry = sourceFor('vault-resolves')
    expect(entry.configModel).toBe(VaultConfig)
    expect(entry.fetch).toBe(fetch)
  })

  it('re-registering a name replaces it', () => {
    const first = (): Promise<ResolvedSecret> => Promise.resolve({ fields: {} })
    const second = (): Promise<ResolvedSecret> => Promise.resolve({ fields: { a: '1' } })
    registerSecrets('vault-replaces', VaultConfig, first)
    registerSecrets('vault-replaces', VaultConfig, second)
    expect(sourceFor('vault-replaces').fetch).toBe(second)
  })

  it('an unknown source throws naming the known ones', () => {
    registerSecrets('vault-known', VaultConfig, () => Promise.resolve({ fields: {} }))
    expect(() => sourceFor('nope')).toThrowError(SecretsError)
    expect(() => sourceFor('nope')).toThrowError(/nope/)
    expect(() => sourceFor('nope')).toThrowError(/vault-known/)
  })

  it('sourceFor refuses a source whose optional peer is absent', () => {
    // A dynamic import would only discover this on the first fetch,
    // and that failure is redacted; python gets the check for free
    // because its sourceFor resolves an import path.
    registerSecrets(
      'vault-nopeer',
      VaultConfig,
      () => Promise.resolve({ fields: {} }),
      () => {
        throw new SecretsError("the 'vault-nopeer' source needs its optional dependency (x)")
      },
    )
    expect(() => sourceFor('vault-nopeer')).toThrowError(/optional dependency \(x\)/)
    // A source without a probe still resolves, so a workspace that
    // does not declare this one pays nothing.
    registerSecrets('vault-peerless', VaultConfig, () => Promise.resolve({ fields: {} }))
    expect(() => sourceFor('vault-peerless')).not.toThrowError()
  })

  it('knownSources sorts every registered name', () => {
    registerSecrets('zz-last', VaultConfig, () => Promise.resolve({ fields: {} }))
    registerSecrets('aa-first', VaultConfig, () => Promise.resolve({ fields: {} }))
    const known = knownSources()
    expect(known.indexOf('aa-first')).toBeLessThan(known.indexOf('zz-last'))
  })

  it('fetchSecret constructs the config from ambient defaults', async () => {
    const seen: VaultConfig[] = []
    registerSecrets('vault-fetch', VaultConfig, (config, ref) => {
      seen.push(config)
      return Promise.resolve({ fields: { token: `t-${ref}` } })
    })
    const secret = await fetchSecret('vault-fetch', 'prod')
    expect(secret.fields).toEqual({ token: 't-prod' })
    expect(seen).toEqual([{ host: 'local' }])
  })

  it('fetchSecret on an unknown source throws SecretsError', async () => {
    await expect(fetchSecret('never-registered', 'r')).rejects.toThrowError(SecretsError)
  })

  it('fetchSecret prefers a declared instance', async () => {
    const seen: string[] = []
    registerSecrets('vault-instance', VaultConfig, () => Promise.resolve({ fields: {} }))
    const sources: Record<string, ResolvedSource> = {
      prod: {
        source: 'vault-instance',
        config: { host: 'declared' },
        fetch: ((config: VaultConfig, ref: string) => {
          seen.push(`${config.host}:${ref}`)
          return Promise.resolve({ fields: { token: 'instance' } })
        }) as never,
      },
    }
    const secret = await fetchSecret('prod', 'r', sources)
    expect(secret.fields).toEqual({ token: 'instance' })
    expect(seen).toEqual(['declared:r'])
  })

  it('a source named after a prototype member is unknown, not inherited', async () => {
    const sources: Record<string, ResolvedSource> = {
      prod: {
        source: 'vault-x',
        config: {},
        fetch: (() => Promise.resolve({ fields: {} })) as never,
      },
    }
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      await expect(fetchSecret(name, '', sources)).rejects.toThrowError(SecretsError)
      await expect(fetchSecret(name, '', sources)).rejects.toThrowError(/unknown secrets source/)
    }
  })

  it('fetchSecret falls back to the source of that name', async () => {
    registerSecrets('vault-fallback', VaultConfig, () =>
      Promise.resolve({ fields: { token: 'ambient' } }),
    )
    const sources: Record<string, ResolvedSource> = {
      prod: {
        source: 'vault-x',
        config: {},
        fetch: (() => Promise.resolve({ fields: {} })) as never,
      },
    }
    const secret = await fetchSecret('vault-fallback', 'r', sources)
    expect(secret.fields).toEqual({ token: 'ambient' })
  })
})

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'

import { OnePasswordConfig } from './config.ts'
import {
  TOKEN_VAR,
  fetchOnePassword,
  fieldsFromItem,
  findItemId,
  findVaultId,
  onePasswordClient,
  parseOpRef,
} from './onepassword.ts'
import { VERSION } from '../version.ts'

interface Overview {
  id: string
  title: string
}

interface Field {
  title: string
  value: string
}

interface FakeState {
  auths: { auth: string; integrationName: string; integrationVersion: string }[]
  vaults: Overview[]
  vaultCalls: number
  overviews: Record<string, Overview[]>
  items: Record<string, { fields: Field[]; notes: string }>
  gets: [string, string][]
  values: Record<string, string>
  resolved: string[]
}

const state: FakeState = {
  auths: [],
  vaults: [],
  vaultCalls: 0,
  overviews: {},
  items: {},
  gets: [],
  values: {},
  resolved: [],
}

vi.mock('@1password/sdk', () => ({
  createClient: (config: { auth: string; integrationName: string; integrationVersion: string }) => {
    state.auths.push(config)
    return Promise.resolve({
      secrets: {
        resolve: (ref: string) => {
          state.resolved.push(ref)
          return Promise.resolve(state.values[ref] ?? '')
        },
      },
      vaults: {
        list: () => {
          state.vaultCalls += 1
          return Promise.resolve(state.vaults)
        },
      },
      items: {
        list: (vaultId: string) => Promise.resolve(state.overviews[vaultId] ?? []),
        get: (vaultId: string, itemId: string) => {
          state.gets.push([vaultId, itemId])
          return Promise.resolve(state.items[itemId])
        },
      },
    })
  },
}))

// The SDK's own Item/VaultOverview carry a dozen fields the source
// never reads; the fake answers with the subset it does read, cast
// once here rather than at each call.
type SdkItem = Parameters<typeof fieldsFromItem>[0]

function makeItem(fields: Field[], notes = ''): SdkItem {
  return { fields, notes } as unknown as SdkItem
}

const config = OnePasswordConfig.parse({ token: 'ops_test' })

describe('parseOpRef', () => {
  it.each<[string, [string, string, string]]>([
    ['op://mirage/SLACK_BOT_TOKEN', ['mirage', 'SLACK_BOT_TOKEN', '']],
    ['op://mirage/tok/credential', ['mirage', 'tok', 'credential']],
    ['op://mirage/aws/keys/access_key_id', ['mirage', 'aws', 'access_key_id']],
  ])('%s splits to %j', (ref, [vault, item, field]) => {
    expect(parseOpRef(ref)).toEqual({ vault, item, field })
  })

  it.each<[string, RegExp]>([
    ['', /needs a ref/],
    ['mirage/tok', /op:\/\/ url/],
    ['op://mirage', /a vault and an item/],
    ['op://mirage/', /a vault and an item/],
    ['op:///tok', /a vault and an item/],
  ])('refuses %s', (ref, message) => {
    expect(() => parseOpRef(ref)).toThrowError(SecretsError)
    expect(() => parseOpRef(ref)).toThrowError(message)
  })
})

describe('fieldsFromItem', () => {
  it('keys every labelled field by its label', () => {
    expect(
      fieldsFromItem(
        makeItem([
          { title: 'username', value: 'u' },
          { title: 'credential', value: 'shh' },
        ]),
      ),
    ).toEqual({ username: 'u', credential: 'shh' })
  })

  it('folds the note in as notesPlain', () => {
    expect(fieldsFromItem(makeItem([{ title: 'credential', value: 'shh' }], 'hi'))).toEqual({
      credential: 'shh',
      notesPlain: 'hi',
    })
  })

  it('skips an unlabelled field', () => {
    expect(
      fieldsFromItem(
        makeItem([
          { title: '', value: 'x' },
          { title: 'credential', value: 'shh' },
        ]),
      ),
    ).toEqual({ credential: 'shh' })
  })

  it('keeps a __proto__ field as an own property', () => {
    // Keyed assignment would run the prototype setter and leave no own
    // property, so a `key: __proto__` would report the field missing;
    // python's dict keeps the label like any other.
    const fields = fieldsFromItem(makeItem([{ title: '__proto__', value: 'shh' }]))
    expect(Object.hasOwn(fields, '__proto__')).toBe(true)
    expect(fields.__proto__).toBe('shh')
  })

  it('keeps a notesPlain field over the note', () => {
    expect(
      fieldsFromItem(makeItem([{ title: 'notesPlain', value: 'from-field' }], 'from-note')),
    ).toEqual({ notesPlain: 'from-field' })
  })
})

describe('fetchOnePassword', () => {
  beforeEach(() => {
    state.auths = []
    state.vaults = [{ id: 'v1', title: 'mirage' }]
    state.vaultCalls = 0
    state.overviews = { v1: [{ id: 'i1', title: 'aws' }] }
    state.items = {
      i1: {
        fields: [
          { title: 'access_key_id', value: 'AKIA' },
          { title: 'secret_access_key', value: 'shh' },
        ],
        notes: '',
      },
    }
    state.gets = []
    state.values = {}
    state.resolved = []
  })

  afterEach(() => {
    Reflect.deleteProperty(process.env, TOKEN_VAR)
  })

  it('reads every field of an item ref on one get', async () => {
    const secret = await fetchOnePassword(config, 'op://mirage/aws')
    expect(secret.fields).toEqual({ access_key_id: 'AKIA', secret_access_key: 'shh' })
    expect(secret.expiresAt).toBeUndefined()
    expect(state.gets).toEqual([['v1', 'i1']])
    expect(state.resolved).toEqual([])
  })

  it('matches a vault and an item by id', async () => {
    const secret = await fetchOnePassword(config, 'op://v1/i1')
    expect(secret.fields).toEqual({ access_key_id: 'AKIA', secret_access_key: 'shh' })
  })

  it('resolves a field ref without listing anything', async () => {
    const ref = 'op://mirage/tok/credential'
    state.values = { [ref]: 'shh' }
    const secret = await fetchOnePassword(config, ref)
    expect(secret.fields).toEqual({ credential: 'shh' })
    expect(state.resolved).toEqual([ref])
    expect(state.vaultCalls).toBe(0)
    expect(state.gets).toEqual([])
  })

  it('refuses an unknown vault', async () => {
    state.vaults = [{ id: 'v1', title: 'other' }]
    await expect(fetchOnePassword(config, 'op://mirage/aws')).rejects.toThrowError(
      /vault 'mirage' not found/,
    )
  })

  it('refuses an unknown item', async () => {
    state.overviews = { v1: [{ id: 'i1', title: 'other' }] }
    await expect(fetchOnePassword(config, 'op://mirage/aws')).rejects.toThrowError(
      /item 'aws' not found/,
    )
  })

  it('uses the configured token over the env one', async () => {
    process.env[TOKEN_VAR] = 'ops_from_env'
    await onePasswordClient(config)
    expect(state.auths).toEqual([
      { auth: 'ops_test', integrationName: 'mirage', integrationVersion: VERSION },
    ])
  })

  it('falls back to the env token', async () => {
    process.env[TOKEN_VAR] = 'ops_from_env'
    await onePasswordClient(OnePasswordConfig.parse({}))
    expect(state.auths).toEqual([
      { auth: 'ops_from_env', integrationName: 'mirage', integrationVersion: VERSION },
    ])
  })

  it('refuses a missing token before loading the SDK', async () => {
    Reflect.deleteProperty(process.env, TOKEN_VAR)
    await expect(onePasswordClient(OnePasswordConfig.parse({}))).rejects.toThrowError(SecretsError)
    await expect(onePasswordClient(OnePasswordConfig.parse({}))).rejects.toThrowError(TOKEN_VAR)
    expect(state.auths).toEqual([])
  })
})

describe('findVaultId and findItemId', () => {
  it('report the name they could not match', async () => {
    const client = { vaults: { list: () => Promise.resolve([]) } }
    await expect(
      findVaultId(client as unknown as Parameters<typeof findVaultId>[0], 'gone'),
    ).rejects.toThrowError(/vault 'gone' not found/)
    const empty = { items: { list: () => Promise.resolve([]) } }
    await expect(
      findItemId(empty as unknown as Parameters<typeof findItemId>[0], 'v1', 'gone'),
    ).rejects.toThrowError(/item 'gone' not found/)
  })
})

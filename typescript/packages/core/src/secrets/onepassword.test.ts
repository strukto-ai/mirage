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

import { afterEach, describe, expect, it } from 'vitest'

import { SecretsError } from './errors.ts'
import { OnePasswordConfig } from './config.ts'
import {
  TOKEN_VAR,
  readOnepassword,
  serviceAccountToken,
  type OnePasswordClient,
} from './onepassword.ts'

// The SDK's reads themselves are node's tests (packages/node), through
// its install; these cover what any runtime's client goes through.

const client: OnePasswordClient = {
  secrets: { resolve: (ref) => Promise.resolve(`resolved ${ref}`) },
  vaults: { list: () => Promise.resolve([{ id: 'v1', title: 'Engineering' }]) },
  items: {
    list: () => Promise.resolve([{ id: 'i1', title: 'Slack' }]),
    get: () => Promise.resolve({ fields: [{ title: 'credential', value: 'xoxb' }], notes: '' }),
  },
}

describe('readOnepassword', () => {
  it('resolves a field ref as itself, and an item ref as its fields', async () => {
    const connect = () => Promise.resolve(client)
    await expect(readOnepassword('op://Engineering/Slack/credential', connect)).resolves.toEqual({
      fields: { credential: 'resolved op://Engineering/Slack/credential' },
    })
    await expect(readOnepassword('op://Engineering/Slack', connect)).resolves.toEqual({
      fields: { credential: 'xoxb' },
    })
  })

  it('checks the ref before it connects', async () => {
    let connected = false
    const connect = () => {
      connected = true
      return Promise.resolve(client)
    }
    await expect(readOnepassword('Engineering/Slack', connect)).rejects.toThrow(SecretsError)
    expect(connected).toBe(false)
  })
})

describe('serviceAccountToken', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, TOKEN_VAR)
  })

  it('takes the config’s token over the env’s', () => {
    process.env[TOKEN_VAR] = 'ops_env'
    expect(serviceAccountToken(OnePasswordConfig.parse({ token: 'ops_config' }))).toBe('ops_config')
    expect(serviceAccountToken(OnePasswordConfig.parse({}))).toBe('ops_env')
  })

  it('refuses when neither has one', () => {
    expect(() => serviceAccountToken(OnePasswordConfig.parse({}))).toThrow(TOKEN_VAR)
  })
})

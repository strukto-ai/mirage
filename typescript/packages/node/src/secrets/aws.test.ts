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

import { describe, expect, it, vi } from 'vitest'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'

import { AWSSMConfig } from './config.ts'
import { fetchAwsSm, fieldsFromSecretString } from './aws.ts'

interface FakeState {
  configs: Record<string, unknown>[]
  secretIds: string[]
  answer: { SecretString?: string }
  destroyed: number
}

const state: FakeState = { configs: [], secretIds: [], answer: {}, destroyed: 0 }

vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    readonly input: { SecretId: string }
    constructor(input: { SecretId: string }) {
      this.input = input
    }
  }
  class SecretsManagerClient {
    constructor(config: Record<string, unknown>) {
      state.configs.push(config)
    }
    send(command: GetSecretValueCommand): Promise<{ SecretString?: string }> {
      state.secretIds.push(command.input.SecretId)
      return Promise.resolve(state.answer)
    }
    destroy(): void {
      state.destroyed += 1
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient }
})

describe('fieldsFromSecretString', () => {
  it.each<[string, Record<string, string>]>([
    ['{"user":"u","pass":"p"}', { user: 'u', pass: 'p' }],
    ['plain-token', { value: 'plain-token' }],
    ['[1,2]', { value: '[1,2]' }],
    ['{"n":1}', { value: '{"n":1}' }],
    ['{}', {}],
  ])('%s shapes to %j', (text, fields) => {
    expect(fieldsFromSecretString(text)).toEqual(fields)
  })
})

describe('fetchAwsSm', () => {
  it('refuses an empty ref before touching the SDK', async () => {
    await expect(fetchAwsSm(AWSSMConfig.parse({}), '')).rejects.toThrowError(SecretsError)
    await expect(fetchAwsSm(AWSSMConfig.parse({}), '')).rejects.toThrowError(/needs a ref/)
  })

  it('passes the ref as SecretId and shapes the SecretString', async () => {
    state.answer = { SecretString: '{"api":"k1"}' }
    const before = state.destroyed
    const secret = await fetchAwsSm(AWSSMConfig.parse({ region: 'us-east-1' }), 'prod/tokens')
    expect(secret.fields).toEqual({ api: 'k1' })
    expect(state.secretIds.at(-1)).toBe('prod/tokens')
    expect(state.configs.at(-1)).toEqual({ region: 'us-east-1' })
    expect(state.destroyed).toBe(before + 1)
  })

  it('carries explicit credentials into the client', async () => {
    state.answer = { SecretString: 't' }
    await fetchAwsSm(
      AWSSMConfig.parse({
        awsAccessKeyId: 'AKIA',
        awsSecretAccessKey: 'sk',
        awsSessionToken: 'st',
      }),
      'r',
    )
    expect(state.configs.at(-1)).toEqual({
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'sk', sessionToken: 'st' },
    })
  })

  it('refuses a binary secret', async () => {
    state.answer = {}
    await expect(fetchAwsSm(AWSSMConfig.parse({}), 'bin')).rejects.toThrowError(
      /binary \(SecretBinary\)/,
    )
  })
})

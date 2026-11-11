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

import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

// The secret sources a Worker reads, in workerd. A read against a real
// store runs when its credentials are in the environment: a service
// account token and a ref for 1Password, keys and a secret for AWS.

let worker: Unstable_DevWorker

interface Answer {
  readonly fields?: Record<string, number>
  readonly error?: string
}

async function read(source: string, config: Record<string, unknown>, ref: string) {
  const response = await worker.fetch('http://secrets.test/', {
    method: 'POST',
    body: JSON.stringify({ source, config, ref }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Answer
}

beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('./secrets_worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./secrets.toml', import.meta.url)),
    experimental: { disableExperimentalWarning: true },
    logLevel: 'error',
  })
}, 120_000)

afterAll(async () => {
  await worker.stop()
})

it('loads 1Password’s SDK, whose own check refuses a token that isn’t one', async () => {
  const answer = await read('1password', { token: 'ops_not-a-token' }, 'op://vault/item/field')
  expect(answer.error).toMatch(/invalid service account token/)
})

it('signs aws-sm’s reads itself, refusing a config without keys', async () => {
  const answer = await read('aws-sm', { region: 'us-east-1' }, 'prod/github')
  expect(answer.error).toMatch(/needs region, aws_access_key_id and aws_secret_access_key/)
})

const OP_TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN
const OP_REF = process.env.MIRAGE_TEST_OP_REF

it.skipIf(OP_TOKEN === undefined || OP_REF === undefined)('reads a 1Password secret', async () => {
  const answer = await read('1password', { token: OP_TOKEN }, OP_REF ?? '')
  expect(answer.error).toBeUndefined()
  expect(Object.values(answer.fields ?? {}).some((length) => length > 0)).toBe(true)
})

const AWS_SECRET = process.env.MIRAGE_TEST_AWS_SECRET

it.skipIf(AWS_SECRET === undefined || process.env.AWS_ACCESS_KEY_ID === undefined)(
  'reads an AWS Secrets Manager secret',
  async () => {
    const answer = await read(
      'aws-sm',
      {
        region: process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION,
        aws_access_key_id: process.env.AWS_ACCESS_KEY_ID,
        aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
      },
      AWS_SECRET ?? '',
    )
    expect(answer.error).toBeUndefined()
    expect(Object.values(answer.fields ?? {}).some((length) => length > 0)).toBe(true)
  },
)

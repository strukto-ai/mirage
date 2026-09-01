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

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'

import { EnvConfig } from './config.ts'
import { fetchEnv } from './env.ts'

describe('fetchEnv', () => {
  afterEach(() => {
    delete process.env.MIRAGE_TEST_ENV_SECRET
  })

  it('reads the whole process environment as fields', async () => {
    process.env.MIRAGE_TEST_ENV_SECRET = 'from-env'
    const secret = await fetchEnv(EnvConfig.parse({}), '')
    expect(secret.fields.MIRAGE_TEST_ENV_SECRET).toBe('from-env')
  })

  it('refuses a ref: the process env has no sub-address', async () => {
    await expect(fetchEnv(EnvConfig.parse({}), 'x')).rejects.toThrowError(SecretsError)
    await expect(fetchEnv(EnvConfig.parse({}), 'x')).rejects.toThrowError(/takes no ref/)
  })
})

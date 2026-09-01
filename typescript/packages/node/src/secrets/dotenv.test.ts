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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'

import { DotenvConfig } from './config.ts'
import { fetchDotenv } from './dotenv.ts'

const dir = mkdtempSync(join(tmpdir(), 'mirage-dotenv-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('fetchDotenv', () => {
  it('reads the file the ref names', async () => {
    const path = join(dir, 'ref.env')
    writeFileSync(path, 'API_KEY=k1\nDB_URL=postgres://x\n')
    const secret = await fetchDotenv(DotenvConfig.parse({}), path)
    expect(secret.fields).toEqual({ API_KEY: 'k1', DB_URL: 'postgres://x' })
  })

  it('an empty ref falls back to the configured path', async () => {
    const path = join(dir, 'default.env')
    writeFileSync(path, 'ONLY=here\n')
    const secret = await fetchDotenv(DotenvConfig.parse({ path }), '')
    expect(secret.fields).toEqual({ ONLY: 'here' })
  })

  it('a missing file is a SecretsError naming the path', async () => {
    const path = join(dir, 'absent.env')
    await expect(fetchDotenv(DotenvConfig.parse({}), path)).rejects.toThrowError(SecretsError)
    await expect(fetchDotenv(DotenvConfig.parse({}), path)).rejects.toThrowError(
      /dotenv file not found/,
    )
  })

  it('never interpolates: a ${NAME} in a value stays literal', async () => {
    process.env.HOST_TOKEN = 'host-secret'
    try {
      const path = join(dir, 'literal.env')
      writeFileSync(path, 'API_TOKEN=${HOST_TOKEN}\nA=x\nB=${A}-y\nC=$A\n')
      const secret = await fetchDotenv(DotenvConfig.parse({}), path)
      expect(secret.fields).toEqual({
        API_TOKEN: '${HOST_TOKEN}',
        A: 'x',
        B: '${A}-y',
        C: '$A',
      })
    } finally {
      delete process.env.HOST_TOKEN
    }
  })
})

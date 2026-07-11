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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultTokenFile, ensureTokenFile, readTokenFile } from './storage.ts'

describe('storage', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-auth-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('ensureTokenFile creates with 0o600', () => {
    const target = join(dir, 'subdir', 'auth_token')
    const token = ensureTokenFile(target)
    expect(token.length).toBeGreaterThan(0)
    expect(readFileSync(target, 'utf-8').trim()).toBe(token)
    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('ensureTokenFile is idempotent', () => {
    const target = join(dir, 'auth_token')
    const first = ensureTokenFile(target)
    const second = ensureTokenFile(target)
    expect(second).toBe(first)
  })

  it('readTokenFile returns undefined when file is missing', () => {
    const target = join(dir, 'absent')
    expect(readTokenFile(target)).toBeUndefined()
  })

  it('readTokenFile returns stripped contents', () => {
    const target = join(dir, 'auth_token')
    writeFileSync(target, '  abc-def  \n')
    expect(readTokenFile(target)).toBe('abc-def')
  })

  it('defaultTokenFile follows MIRAGE_HOME', () => {
    expect(defaultTokenFile({ MIRAGE_HOME: '/data/mirage' })).toBe(
      join('/data/mirage', 'auth_token'),
    )
  })
})

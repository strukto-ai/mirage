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

import { fetchSecret, knownSources, sourceFor } from '@struktoai/mirage-core/secrets/registry'

import { BUILTIN_SOURCE_NAMES } from './constants.ts'

describe('builtin registration', () => {
  afterEach(() => {
    delete process.env.MIRAGE_TEST_BUILTIN_SECRET
  })

  it('importing the module arms every builtin source', () => {
    for (const name of BUILTIN_SOURCE_NAMES) {
      expect(knownSources()).toContain(name)
      expect(sourceFor(name).fetch).toBeTypeOf('function')
    }
  })

  it('the 1password builtin resolves while its peer is installed', () => {
    // The probe asks the resolver, it does not load the SDK, so this
    // passes here (devDependency) and refuses with the package to
    // install where the optional peer is absent.
    expect(() => sourceFor('1password')).not.toThrowError()
  })

  it('the env builtin fetches through the lazy wrapper', async () => {
    process.env.MIRAGE_TEST_BUILTIN_SECRET = 'armed'
    const secret = await fetchSecret('env', '')
    expect(secret.fields.MIRAGE_TEST_BUILTIN_SECRET).toBe('armed')
  })
})

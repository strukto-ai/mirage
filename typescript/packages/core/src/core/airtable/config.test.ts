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
import { AirtableAccessor } from '../../accessor/airtable.ts'
import { AirtableConfigSchema } from './config.ts'
import { parseConfigWithSchema, redactConfigWithSchema } from '../../vfs/secrets.ts'

describe('airtable config', () => {
  it('points at the public api by default', () => {
    const accessor = new AirtableAccessor(
      parseConfigWithSchema(AirtableConfigSchema, { token: 't' }),
    )
    expect(accessor.baseUrl).toBe('https://api.airtable.com/v0')
    expect(accessor.maxReadRecords).toBe(10_000)
    expect(accessor.baseIds).toBeNull()
  })

  it('reads the snake_case yaml spelling', () => {
    const config = parseConfigWithSchema(AirtableConfigSchema, {
      token: 't',
      base_ids: ['appA'],
      max_read_records: 3,
      requests_per_second: 2,
    })
    expect(config.baseIds).toEqual(['appA'])
    expect(config.maxReadRecords).toBe(3)
  })

  it('refuses a misspelled key', () => {
    expect(() =>
      parseConfigWithSchema(AirtableConfigSchema, { token: 't', base_idz: ['appX'] }),
    ).toThrow()
  })

  it.each([
    ['max_read_records', 0],
    ['requests_per_second', 0],
  ])('refuses a non-positive %s', (key, value) => {
    expect(() =>
      parseConfigWithSchema(AirtableConfigSchema, { token: 't', [key]: value }),
    ).toThrow()
  })

  it('redacts the token', () => {
    expect(
      JSON.stringify(redactConfigWithSchema(AirtableConfigSchema, { token: 'pat.secret' })),
    ).not.toContain('pat.secret')
  })
})

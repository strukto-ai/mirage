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

import { describe, expect, expectTypeOf, it } from 'vitest'
import { errorSummary } from '../secrets/summary.ts'
import {
  FIELD_NORMALIZERS,
  hasRedactedSecret,
  normalizeNonEmpty,
  parseConfigWithSchema,
  REDACTED_SECRET,
  redactConfigWithSchema,
  refuseRepeatedFields,
  refuseUnknownKeys,
  secretSchema,
  secretStr,
  z,
} from './secrets.ts'

const Schema = z.object({ apiKey: z.string(), teamIds: z.array(z.string()).optional() })

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (err) {
    if (err instanceof z.ZodError) return errorSummary(err)
    throw err
  }
  throw new Error('expected a refusal')
}

describe('parseConfigWithSchema', () => {
  it('refuses a key no field takes, in the spelling it was written in', () => {
    expect(refusal(() => parseConfigWithSchema(Schema, { api_key: 'k', team_idz: ['x'] }))).toBe(
      'team_idz: unrecognized_keys',
    )
  })

  it('names every unknown key, one issue each, in input order', () => {
    expect(refusal(() => parseConfigWithSchema(Schema, { api_key: 'k', b: 1, a: 2 }))).toBe(
      'b: unrecognized_keys; a: unrecognized_keys',
    )
  })

  it('looks a key up under the name the normalizer writes it to', () => {
    const parsed = parseConfigWithSchema(
      Schema.clone().register(FIELD_NORMALIZERS, { rename: { developer_token: 'apiKey' } }),
      { developer_token: 'k', team_ids: ['t'] },
    )
    expect(parsed).toEqual({ apiKey: 'k', teamIds: ['t'] })
    expect(parseConfigWithSchema(Schema, { apiKey: 'k' })).toEqual({ apiKey: 'k' })
  })

  it('names a strict schema’s unknown key as written, not as renamed', () => {
    const Strict = Schema.strict()
    expect(refusal(() => parseConfigWithSchema(Strict, { api_key: 'k', page_sizee: 1 }))).toBe(
      'page_sizee: unrecognized_keys',
    )
  })

  it('leaves a schema that passes extras through to its own policy', () => {
    const Loose = Schema.loose()
    expect(parseConfigWithSchema(Loose, { api_key: 'k', extra_key: 1 })).toEqual({
      apiKey: 'k',
      extraKey: 1,
    })
  })

  it('treats a dropped key as known', () => {
    expect(
      parseConfigWithSchema(Schema.clone().register(FIELD_NORMALIZERS, { drop: ['proxy'] }), {
        api_key: 'k',
        proxy: 'p',
      }),
    ).toEqual({ apiKey: 'k' })
  })
})

describe('refuseUnknownKeys', () => {
  it('refuses against an explicit option list', () => {
    expect(
      refusal(() => {
        refuseUnknownKeys({ root: '/', roots: '/x' }, ['root'])
      }),
    ).toBe('roots: unrecognized_keys')
    expect(() => {
      refuseUnknownKeys({ key_prefix: 'p' }, ['keyPrefix'])
    }).not.toThrow()
  })

  it('does not read a prototype member as a declared option', () => {
    expect(
      refusal(() => {
        refuseUnknownKeys({ constructor: 1 }, [])
      }),
    ).toBe('constructor: unrecognized_keys')
  })
})

describe('refuseRepeatedFields', () => {
  it("keeps the block's values out of the error", () => {
    try {
      refuseRepeatedFields({
        url: 'redis://:hunter2@h:6379',
        keyPrefix: 'hunter2',
        key_prefix: 'hunter3',
      })
    } catch (err) {
      expect(String(err)).not.toMatch(/hunter/)
      return
    }
    throw new Error('expected a refusal')
  })

  it('names every repeated field, one issue each', () => {
    expect(
      refusal(() => {
        refuseRepeatedFields({
          keyPrefix: 'a:',
          key_prefix: 'b:',
          max_drain_bytes: 1,
          maxDrainBytes: 2,
        })
      }),
    ).toBe('keyPrefix: unrecognized_keys; maxDrainBytes: unrecognized_keys')
  })
})

describe('redactConfigWithSchema', () => {
  it('redacts a record of secrets whole, as Python redacts dict[str, SecretStr]', () => {
    const schema = z.object({ env: z.record(z.string(), secretStr()), url: z.string() })
    const redacted = redactConfigWithSchema(schema, { env: { TOKEN: 's' }, url: 'u' })
    expect(redacted).toEqual({ env: REDACTED_SECRET, url: 'u' })
    expect(hasRedactedSecret(redacted)).toBe(true)
  })

  it('leaves a record of plain strings as it is', () => {
    const schema = z.object({ labels: z.record(z.string(), z.string()) })
    expect(redactConfigWithSchema(schema, { labels: { team: 'a' } })).toEqual({
      labels: { team: 'a' },
    })
  })
})

describe('normalizeNonEmpty', () => {
  it('trims a value and refuses a blank one by field', () => {
    expect(normalizeNonEmpty('  docs ', 'collectionName')).toBe('docs')
    expect(() => normalizeNonEmpty('   ', 'datasetId')).toThrow('datasetId cannot be empty')
  })
})

it('infers redaction from optional, nullable, callback, and nested secret schemas', () => {
  const schema = z.object({
    token: secretStr().optional(),
    absent: secretStr().nullable(),
    provider: secretSchema(z.custom<() => Promise<string>>()),
    headers: z.record(z.string(), secretStr()),
    nested: z.object({ key: secretStr(), label: z.string() }).nullable(),
    rows: z.array(z.object({ key: secretStr().default('default-key') })),
    public: z.string().default('visible'),
  })
  const state = redactConfigWithSchema(schema, {
    absent: null,
    provider: () => Promise.resolve('private'),
    headers: { Authorization: 'private' },
    nested: { key: 'private', label: 'label' },
    rows: [{}],
  })
  expectTypeOf(state).toEqualTypeOf<{
    token?: typeof REDACTED_SECRET
    absent: typeof REDACTED_SECRET | null
    provider: typeof REDACTED_SECRET
    headers: typeof REDACTED_SECRET
    nested: { key: typeof REDACTED_SECRET; label: string } | null
    rows: { key: typeof REDACTED_SECRET }[]
    public: string
  }>()
  expect(state).toEqual({
    absent: null,
    provider: REDACTED_SECRET,
    headers: REDACTED_SECRET,
    nested: { key: REDACTED_SECRET, label: 'label' },
    rows: [{ key: REDACTED_SECRET }],
    public: 'visible',
  })
})

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
import { z } from 'zod'

import { MAX_LISTED_FIELDS, errorSummary, fieldSummary } from './summary.ts'

describe('fieldSummary', () => {
  it('lists a secret-sized secret', () => {
    expect(fieldSummary({ username: 'u', credential: 'x' }, 'op')).toBe('{credential, username}')
  })

  it('lists nothing for an empty secret', () => {
    expect(fieldSummary({}, 'op')).toBe('{}')
  })

  it('lists up to the cap', () => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < MAX_LISTED_FIELDS; i += 1) fields[`f${String(i).padStart(2, '0')}`] = 'v'
    expect(fieldSummary(fields, 'op')).toBe(`{${Object.keys(fields).join(', ')}}`)
  })

  it('counts a process environment instead of reciting it', () => {
    const fields: Record<string, string> = {}
    for (let i = 0; i <= MAX_LISTED_FIELDS; i += 1) fields[`f${String(i).padStart(2, '0')}`] = 'v'
    const summary = fieldSummary(fields, 'op')
    expect(summary).toBe(`${String(MAX_LISTED_FIELDS + 1)} fields`)
    expect(summary).not.toContain('f00')
  })

  it('never lists the process environment', () => {
    // A hardened container starts from `env -i` plus a handful of
    // credentials, so a count threshold alone would recite exactly the
    // environment worth hiding.
    const fields = { HOME: '/root', AWS_SESSION_TOKEN: 't' }
    expect(fieldSummary(fields, 'env')).toBe('2 fields')
    expect(fieldSummary(fields, 'env')).not.toContain('AWS_SESSION_TOKEN')
  })
})

describe('errorSummary', () => {
  const Refusing = z.strictObject({
    port: z.number(),
    token: z
      .string()
      .superRefine((value, ctx) => {
        if (value.startsWith('sk-')) {
          ctx.addIssue({ code: 'custom', message: `a live key is not allowed here: ${value}` })
        }
      })
      .default(''),
  })

  function refusal(input: Record<string, unknown>): z.ZodError {
    const parsed = Refusing.safeParse(input)
    if (parsed.success) throw new Error('expected a refusal')
    return parsed.error
  }

  it('names the field and the code only', () => {
    expect(errorSummary(refusal({ port: 'x' }))).toBe('port: invalid_type')
  })

  it('never carries the input', () => {
    // A refinement is free to build its message out of the value it
    // refused; neither the message nor the input may reach a 400 body.
    const summary = errorSummary(refusal({ port: 1, token: 'sk-live-SUPERSECRET' }))
    expect(summary).toBe('token: custom')
    expect(summary).not.toContain('SUPERSECRET')
  })

  it('joins every issue', () => {
    expect(errorSummary(refusal({ port: 'x', token: 'sk-1' }))).toBe(
      'port: invalid_type; token: custom',
    )
  })

  it('reports a model-level refinement as config, like python', () => {
    const OneOfTwo = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((v) => v.a !== undefined || v.b !== undefined, { message: 'needs a or b' })
    const parsed = OneOfTwo.safeParse({})
    if (parsed.success) throw new Error('expected a refusal')
    expect(errorSummary(parsed.error)).toBe('config: custom')
  })

  it('names the keys of an unrecognized-keys issue', () => {
    expect(errorSummary(refusal({ port: 1, extra: 1 }))).toBe('extra: unrecognized_keys')
  })
})

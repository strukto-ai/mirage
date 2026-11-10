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

import { FS_CONDITIONS } from '@struktoai/mirage-core/errors/types'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { describe, expect, it } from 'vitest'
import {
  ERRNO_CODE,
  ErrorCode,
  fsError,
  HttpError,
  loaderError,
  STATUS,
  validationError,
  WorkspaceMissing,
} from './errors.ts'

const Body = z.strictObject({
  name: z.string(),
  count: z.int().optional(),
  mode: z.enum(['read', 'write']).optional(),
  tags: z.array(z.string()).optional(),
})

function first(body: unknown, under: readonly string[] = []): Record<string, unknown> {
  const checked = Body.safeParse(body)
  if (checked.success) throw new Error('the body passed')
  return validationError(checked.error, body, under).body().error
}

describe('errors', () => {
  it('answers one status for every code and a code for every errno', () => {
    expect(Object.keys(STATUS).sort()).toEqual(Object.values(ErrorCode).sort())
    expect(Object.keys(ERRNO_CODE).sort()).toEqual([...FS_CONDITIONS].sort())
  })

  it('reports the first declared field and unknown keys last', () => {
    expect(first({ zz: 1, count: 'x', name: 5 })).toEqual({
      code: 'invalid_value',
      message: 'name must be a string',
      param: 'name',
    })
    expect(first({ zz: 1, count: 'x' })).toEqual({
      code: 'missing_field',
      message: 'name is required',
      param: 'name',
    })
    expect(first({ yy: 1, zz: 1, name: 'a' })).toEqual({
      code: 'unknown_field',
      message: 'yy is not a known field',
      param: 'yy',
    })
  })

  it('names the choices, never the value', () => {
    expect(first({ name: 'a', mode: 'secret-value' })).toEqual({
      code: 'invalid_value',
      message: 'mode must be one of read, write',
      param: 'mode',
    })
    expect(JSON.stringify(first({ name: 'secret-value', tags: [3] }))).not.toContain('secret-value')
  })

  it('names a nested field by its dotted path', () => {
    expect(first({ name: 'a', tags: ['x', 3] }, ['config'])).toEqual({
      code: 'invalid_value',
      message: 'config.tags[1] must be a string',
      param: 'config.tags[1]',
    })
  })

  it('names no field for a body that is not an object', () => {
    expect(first([1])).toEqual({ code: 'invalid_request', message: 'body must be a JSON object' })
  })

  it("keeps a loader's own text", () => {
    const error = loaderError(new Error("unknown profile 'x'"))
    expect([error.status, error.body()]).toEqual([
      400,
      { error: { code: 'invalid_request', message: "unknown profile 'x'" } },
    ])
  })

  it('reads no field as missing when the checked value is not at hand', () => {
    const checked = Body.safeParse({})
    if (checked.success) throw new Error('an empty body passed')
    expect(loaderError(checked.error, ['config']).record()).toEqual({
      code: 'invalid_value',
      message: 'config.name must be a string',
      param: 'config.name',
    })
  })

  it('carries an optional field only when it is set', () => {
    expect(new HttpError('invalid_request', 'add aws first', { missing: ['aws'] }).body()).toEqual({
      error: { code: 'invalid_request', message: 'add aws first', missing: ['aws'] },
    })
  })

  it('answers a stopped workspace apart from a missing one', () => {
    const missing = new WorkspaceMissing('w')
    expect([missing.status, missing.body()]).toEqual([
      404,
      { error: { code: 'not_found', message: 'workspace not found' } },
    ])
    expect([missing.stopped().status, missing.stopped().body()]).toEqual([
      409,
      { error: { code: 'workspace_stopped', message: "workspace 'w' is stopped; start it first" } },
    ])
  })

  it.each([
    new Error('backend token=secret'),
    new TypeError('backend token=secret'),
    Object.assign(new Error('backend token=secret'), { code: 'ECONNREFUSED' }),
    'backend token=secret',
  ])('hides an unknown backend failure (%s)', (err) => {
    expect(fsError(err).record()).toEqual({ code: 'internal', message: 'internal server error' })
  })

  it.each([
    ['ENOENT', 'not_found', 'No such file or directory'],
    ['EACCES', 'forbidden', 'Permission denied'],
    ['EDQUOT', 'storage_full', 'Disk quota exceeded'],
    ['EIO', 'internal', 'Input/output error'],
  ])('answers only the public errno text for %s', (errno, code, message) => {
    const err = Object.assign(new Error('backend token=secret at /private/config'), { code: errno })
    expect(fsError(err).record()).toEqual({ code, message, errno })
  })

  it("keeps a policy's refusal record", () => {
    const err = new PolicyDenied('backend token=secret', '/private/config', {
      kind: 'pending',
      reason: 'sign-off',
      policy: '',
      askId: 'abc123',
    })
    expect(fsError(err).record()).toEqual({
      code: 'policy_refused',
      message: 'Permission denied',
      errno: 'EACCES',
      refusal: { kind: 'pending', reason: 'sign-off', policy: '', ask_id: 'abc123' },
    })
  })
})

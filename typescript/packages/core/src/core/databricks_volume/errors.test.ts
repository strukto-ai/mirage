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
import { DatabricksVolumeApiError, isNotFound } from './errors.ts'

describe('isNotFound', () => {
  it('matches 404 status codes', () => {
    expect(isNotFound(new DatabricksVolumeApiError('boom', 404))).toBe(true)
  })

  it('matches databricks not-found error codes', () => {
    expect(isNotFound(new DatabricksVolumeApiError('x', 500, 'RESOURCE_DOES_NOT_EXIST'))).toBe(true)
    expect(isNotFound(new DatabricksVolumeApiError('x', 500, 'NOT_FOUND'))).toBe(true)
  })

  it('matches not-found phrasing in messages', () => {
    expect(isNotFound(new Error('path Not Found'))).toBe(true)
    expect(isNotFound(new Error('object does not exist'))).toBe(true)
  })

  it('rejects other errors and non-errors', () => {
    expect(isNotFound(new DatabricksVolumeApiError('denied', 403, 'PERMISSION_DENIED'))).toBe(false)
    expect(isNotFound('not an error')).toBe(false)
  })
})

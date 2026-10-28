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

import { NOT_FOUND_TYPES } from './constants.ts'
import { ApiError } from '../api/errors.ts'

/** A >= 400 answer from the Airtable API, with its status and error type. */
export class AirtableApiError extends ApiError {
  readonly errorType: string | null

  constructor(message: string, status: number | null = null, errorType: string | null = null) {
    super(message, status)
    this.name = 'AirtableApiError'
    this.errorType = errorType
  }

  /**
   * Whether the call named something the token cannot see. Airtable
   * answers a well-formed id it cannot resolve with a 403, not a 404: the
   * permission and the existence checks share one answer so a token cannot
   * probe for bases it was not granted.
   */
  get notFound(): boolean {
    return this.status === 404 || (this.errorType !== null && NOT_FOUND_TYPES.has(this.errorType))
  }
}

/**
 * Airtable's error type and message, from any of its body shapes:
 * `{"error": {"type", "message"}}`, the same object without a message, or a
 * bare `{"error": "NOT_FOUND"}` for an unmatched route or a malformed id.
 */
export function errorParts(text: string): [string | null, string | null] {
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return [null, null]
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [null, null]
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string') return [error, null]
  if (typeof error === 'object' && error !== null) {
    const { type, message } = error as { type?: unknown; message?: unknown }
    return [typeof type === 'string' ? type : null, typeof message === 'string' ? message : null]
  }
  return [null, null]
}

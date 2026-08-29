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

export class DatabricksVolumeApiError extends Error {
  readonly statusCode: number
  readonly errorCode: string | null

  constructor(message: string, statusCode: number, errorCode: string | null = null) {
    super(message)
    this.name = 'DatabricksVolumeApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

/**
 * The workspace refused the configured token (401).
 *
 * Its own type because it is the one failure an application can act on:
 * mirage never refreshes or replays, so an expired token reaches the caller
 * as this error, and the fix is to obtain a fresh token and rebuild the
 * resource with a new config.
 */
export class DatabricksVolumeAuthError extends DatabricksVolumeApiError {
  constructor(message: string, statusCode: number, errorCode: string | null = null) {
    super(message, statusCode, errorCode)
    this.name = 'DatabricksVolumeAuthError'
  }
}

const NOT_FOUND_CODES = new Set(['RESOURCE_DOES_NOT_EXIST', 'NOT_FOUND'])

// Messages are the bare path, mirroring Python's builtin OSError subclasses
// (FileNotFoundError(path), NotADirectoryError(path), ...).
export function notFoundError(path: string): Error {
  const e = new Error(path) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

export function notADirectoryError(path: string): Error {
  const e = new Error(path) as Error & { code: string }
  e.code = 'ENOTDIR'
  return e
}

export function alreadyExistsError(path: string): Error {
  const e = new Error(path) as Error & { code: string }
  e.code = 'EEXIST'
  return e
}

export function isADirectoryError(path: string): Error {
  const e = new Error(path) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export function notEmptyError(path: string): Error {
  const e = new Error(path) as Error & { code: string }
  e.code = 'ENOTEMPTY'
  return e
}

export function isNotFound(exc: unknown): boolean {
  if (!(exc instanceof Error)) return false
  const statusCode = (exc as { statusCode?: unknown }).statusCode
  if (statusCode === 404) return true
  const errorCode = (exc as { errorCode?: unknown }).errorCode
  if (typeof errorCode === 'string' && NOT_FOUND_CODES.has(errorCode)) return true
  const message = exc.message.toLowerCase()
  return message.includes('not found') || message.includes('does not exist')
}

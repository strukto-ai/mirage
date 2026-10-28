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

/**
 * A service answered a call with an error: the one base every backend's
 * service error shares, so a caller catches any of them by one type and
 * reads the status the same way. `status` is the HTTP status, null when the
 * failure carried none (an `ok: false` payload, a body that is not the
 * expected shape). A service's own error code stays on its subclass under
 * the service's name for it: `code` on an Error is the filesystem
 * condition here. Mirrors Python's mirage.core.api.errors.ApiError.
 */
export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * A paginated endpoint handed back a cursor it had already sent. Following
 * it would request a page already collected, forever; stopping quietly
 * would return a listing that looks complete and is not. Either way the
 * caller would be misled, so the walk fails instead.
 */
export class PaginationStalledError extends Error {
  readonly cursor: string

  constructor(cursor: string) {
    super(`pagination did not advance: cursor '${cursor}' came back twice`)
    this.name = 'PaginationStalledError'
    this.cursor = cursor
  }
}

/** A buffered binary response exceeded its explicit or default byte budget. */
export class ResponseTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`API response body exceeds ${String(limit)} bytes`)
    this.name = 'ResponseTooLargeError'
    this.limit = limit
  }
}

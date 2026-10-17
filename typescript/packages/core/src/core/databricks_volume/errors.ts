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

export class DatabricksVolumeCredentialError extends Error {
  constructor(cause: unknown) {
    super('databricks_volume: credential provider failed', { cause })
    this.name = 'DatabricksVolumeCredentialError'
  }
}

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

const NOT_FOUND_CODES = new Set(['RESOURCE_DOES_NOT_EXIST', 'NOT_FOUND'])

export function isNotFound(exc: unknown): boolean {
  return (
    exc instanceof DatabricksVolumeApiError &&
    (exc.statusCode === 404 ||
      (exc.statusCode === 400 && exc.errorCode !== null && NOT_FOUND_CODES.has(exc.errorCode)))
  )
}

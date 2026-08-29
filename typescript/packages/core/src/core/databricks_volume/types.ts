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
 * One row of a `GET /api/2.0/fs/directories` listing, as the API sends it.
 *
 * `last_modified` is epoch milliseconds. The field names stay snake_case
 * because this is the wire shape, parsed straight out of the response body.
 */
export interface DatabricksEntry {
  path: string
  is_directory?: boolean
  file_size?: number
  last_modified?: number
  name?: string
}

/** The headers a `HEAD /api/2.0/fs/files` answer carries. */
export interface DatabricksFileMeta {
  contentLength: number | null
  contentType: string | null
  lastModified: string | null
}

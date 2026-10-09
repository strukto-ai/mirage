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

export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2'
export const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2'
export const TOKEN_BUFFER_SECONDS = 300
// The download response header that names the file's metadata, and the
// metadata field that is its content token.
export const RESULT_HEADER = 'Dropbox-API-Result'
export const CONTENT_HASH = 'content_hash'
// The get_metadata 409 summaries that mean the path is not there. Any other
// 409 (restricted_content, malformed_path, locked, ...) names a path that may
// well exist.
export const MISS_SUMMARIES = ['path/not_found', 'path/not_folder'] as const
// A write sent with a rev (upload in update mode, delete_v2 parent_rev)
// answers these when the file changed since that rev, and these when it is
// gone (measured 2026-10-05 for uploads, 2026-10-08 for deletes).
export const LOST_SUMMARIES = ['path/conflict', 'path_write/conflict'] as const
export const GONE_SUMMARIES = ['path/not_found', 'path_lookup/not_found'] as const
export const REV = 'rev'
// How copy_v2 and move_v2 answer a missing source and a taken destination;
// a missing source is answered first (measured 2026-10-08).
export const MISSING_SOURCE = 'from_lookup/not_found'
export const TAKEN = 'to/conflict'
export const TAKEN_BY_FOLDER = 'to/conflict/folder'

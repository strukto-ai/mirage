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

export const BOX_TOKEN_URL = 'https://api.box.com/oauth2/token'
export const BOX_API_BASE = 'https://api.box.com/2.0'
export const BOX_UPLOAD_BASE = 'https://upload.box.com/api/2.0'
export const TOKEN_BUFFER_SECONDS = 300

// The user event stream the watch hooks read: `changes` is the one Box
// documents as carrying file tree changes, without the downloads and
// previews `all` adds.
export const EVENT_STREAM = 'changes'
// Box keeps user events for between two weeks and two months, and a position
// older than that is not refused, it just replays what is left. A checkpoint
// this old relists instead of trusting the replay.
export const EVENT_REPLAY_DAYS = 14
// Events that put an item at the path its `source` names.
export const PLACE_EVENTS: ReadonlySet<string> = new Set([
  'ITEM_CREATE',
  'ITEM_UPLOAD',
  'ITEM_COPY',
  'ITEM_MOVE',
  'ITEM_RENAME',
  'ITEM_UNDELETE_VIA_TRASH',
  'ITEM_MAKE_CURRENT_VERSION',
])
export const TRASH_EVENTS: ReadonlySet<string> = new Set(['ITEM_TRASH'])

// Box's answer to a request whose If-Match no longer holds, and to one on a
// file that is gone (measured 2026-10-05 for uploads, 2026-10-08 for deletes).
export const LOST_STATUS = 412
export const GONE_STATUS = 404
// A name taken, or a non-recursive delete of a folder that is not empty.
export const CONFLICT_STATUS = 409

export const SHA1 = 'sha1'
export const ACTIVE = 'active'
export const ALL_FILES_FOLDER_ID = '0'
export const TRASH_FOLDER_ID = '1'

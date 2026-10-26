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

import type { RetryPolicy } from '../api/client.ts'

// A body this long or longer is refused by a plain PUT and goes up as a
// multipart upload instead; drive9's default inline threshold.
export const SMALL_FILE_LIMIT = 50_000

// The most paths one fs:batch-stat request may carry.
export const BATCH_STAT_LIMIT = 256

// Parts presigned per request during a multipart upload, so a long upload
// never holds a URL past its expiry.
export const PRESIGN_BATCH = 16

// Parts of one upload in flight at once; each holds its bytes in memory.
export const MAX_UPLOAD_WORKERS = 4

// A recursive delete answers 503 once it spends its per-request budget;
// the sweep resumes where it stopped, so the same DELETE is sent again.
export const TREE_DELETE_RETRY: RetryPolicy = {
  statuses: new Set([503]),
  maxRetries: 4,
  maxBackoff: 60,
  delaySource: 'header',
}

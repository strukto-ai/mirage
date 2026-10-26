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

/** Stats a directory listing runs at once. Mirrors Python's LISTING_CONCURRENCY. */
export const LISTING_CONCURRENCY = 16

/**
 * How long a guest's fstat answers by the row its handle last fetched, as
 * FUSE's attr_timeout does for a kernel: CPython's open() and read() stat
 * the descriptor again right after the open. Mirrors Python's
 * FSTAT_ROW_SECONDS.
 */
export const FSTAT_ROW_SECONDS = 1

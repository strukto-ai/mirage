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

import type { FileStat } from '../types.ts'

/**
 * The token an upload reply names for the stored file, or null.
 *
 * `statOf` is the backend's own stat parser, so the write's token is the
 * kind its `stat` reports. The upload has landed by now, so a reply that is
 * not an object, or that the parser cannot read, answers null instead of
 * throwing. Mirrors python's `upload_token`.
 */
export function uploadToken<T extends object>(
  item: T | null | undefined,
  statOf: (item: T) => FileStat,
  virtual: string,
): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  try {
    const token = statOf(item).fingerprint
    return token === null || token === '' ? null : token
  } catch (err) {
    console.warn(`unreadable upload reply for ${virtual}: ${String(err)}`)
    return null
  }
}

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
 * What the backend's upload reply says it stored.
 *
 * A whole-file writer hands this to `settleAfterWrite` so the cache keeps
 * the bytes it sent only where the backend vouches for them. A field the
 * reply does not carry, or one the writer cannot trust (a size filled in
 * from the request rather than read back), stays null.
 */
export interface WriteReceipt {
  /** Byte length the backend reports storing. */
  readonly storedSize: number | null
  /** The content token the reply carries (ETag, cTag), as reads stamp it. */
  readonly token: string | null
}

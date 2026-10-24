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

import { Effect } from './types.ts'

export const FULL_SCAN_LIMIT = 1000

export const LOCAL_FULL_SCAN_LIMIT = 10000

// Every effect that changes the mount: a read-only mount refuses these and
// admission judges them as writes.
export const WRITE_EFFECTS: readonly Effect[] = [
  Effect.WRITE,
  Effect.CREATE,
  Effect.REMOVE,
  Effect.RENAME,
  Effect.COPY,
  Effect.ATTR,
]

// Methods a VFS once defined beside `read`, `write` and `append`, which now
// answer or take a stream themselves, to the one each folded into: a class
// still defining one is refused rather than left uncalled.
export const FOLDED_METHODS: Readonly<Record<string, string>> = {
  readStream: 'read',
  writeStream: 'write',
  appendStream: 'append',
}

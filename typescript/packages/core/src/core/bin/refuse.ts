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

import type { BinAccessor } from '../../accessor/bin.ts'
import type { PathSpec } from '../../types.ts'
import { erofsReadOnly } from '../../errors/fs.ts'

/**
 * Refuse a write into the view, as a read-only file system does. What the
 * view holds is the lookup's to say, so every write op lands here, whatever
 * it would have done; `path` is the path the op writes, a rename's source.
 */
export function refuse(_accessor: BinAccessor, path: PathSpec): Promise<never> {
  return Promise.reject(erofsReadOnly('Read-only file system', path))
}

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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { record } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { dropboxUpload } from './_client.ts'
import { invalidateAncestors } from '../../cache/context.ts'
import { dropboxPathOf } from './paths.ts'

// Single-call upload; Dropbox caps it at ~150 MB (larger files need
// upload sessions, not supported here).
export async function write(
  accessor: DropboxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const startMs = performance.now()
  await dropboxUpload(accessor.tokenManager, dropboxPathOf(accessor, path), data)
  record('write', path.virtual, 'dropbox', data.byteLength, startMs)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}

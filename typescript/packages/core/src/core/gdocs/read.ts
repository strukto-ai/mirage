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

import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import { record, startOp } from '../../observe/context.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { resolveAppEntry } from '../google/entry.ts'
import { MIME } from './constants.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { detectScope } from './scope.ts'

async function readFile(
  accessor: GDocsAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  const row = entry ?? (await resolveAppEntry(accessor.drive, match, path, MIME, makeFilename))
  const timer = startOp()
  const data = await accessor.docs.readDoc(match.slots.file_id ?? '')
  record('read', path.virtual, 'gdocs', data.length, timer, {
    fingerprint: row.fingerprint,
  })
  return data
}

export const read = makeRead<GDocsAccessor>(detectScope, { file: readFile })

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

import type { LangfuseAccessor } from '../../accessor/langfuse.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { jsonBytes } from '../render/json.ts'
import { fetchTraceFile } from './read.ts'
import { EXTRAS } from './readdir.ts'
import { detectScope } from './scope.ts'

// A trace listing stops at defaultTraceLimit and defaultFromTimestamp while
// read fetches any trace by id, so a trace the listing left out is probed
// the way read reaches it; the probe fetched the whole trace, so its
// rendered size is exact. Mirrors python's `_stat_trace`.
async function statTrace(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<FileStat> {
  if (entry !== null) return entry
  const data = await fetchTraceFile(accessor, match, path)
  return new FileStat({
    name: stripSlash(path.vfsPath).split('/').pop() ?? '',
    type: FileType.FILE,
    content: ContentType.JSON,
    size: jsonBytes(data).byteLength,
  })
}

export const stat = makeStat(detectScope, {
  overrides: {
    trace: statTrace,
    session_trace: statTrace,
  },
  extras: EXTRAS,
})

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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { DetectFn, ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { resolveAppEntry } from './entry.ts'

/**
 * The stat of a Google app mount: a file resolves through Drive. A file a
 * corpus listing named is answered by the mount from that listing; one it did
 * not is fetched by its id alone. Sheets, Docs and Slides stat the same tree
 * and differ only in the MIME type a file carries and what they name it.
 * Mirrors Python's `make_app_stat`.
 */
export function makeAppStat<A extends GoogleApiAccessor>(
  mime: string,
  detectScope: DetectFn,
  makeFilename: (title: string, id: string, modified: string) => string,
): ReturnType<typeof makeStat<A>> {
  const fileStat = (accessor: A, match: ScopeMatch, path: PathSpec): Promise<FileStat> =>
    resolveAppEntry(accessor.tokenManager, match, path, mime, makeFilename)
  return makeStat(detectScope, { overrides: { file: fileStat } })
}

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

import type { DifyAccessor } from '../../accessor/dify.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { resolvePath } from './path.ts'

// Index-only stat: never fetches document detail, so `ls`/`ls -l`/`find`
// stay cheap (one listing per mount, no per-entry API call). size stays
// null because the entry size is the uploaded source file (e.g. the
// original PDF), not the rendered segment text this mount serves
// (FileStat.size must be render-derived or null, see the CLAUDE.md FUSE
// rules). The source size remains in extra.source_size.
export async function stat(
  accessor: DifyAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  if (resolved.isDir) {
    return new FileStat({
      name: statName(resolved.virtualKey, resolved.mountPrefix),
      type: FileType.DIRECTORY,
      extra: { children_count: 0 },
    })
  }
  if (resolved.entry === null) throw enoent(spec.virtual)
  const extra: Record<string, unknown> = { ...resolved.entry.extra }
  if (resolved.entry.size !== null) {
    extra.source_size = resolved.entry.size
  }
  const modified = resolved.entry.remoteTime
  return new FileStat({
    name: resolved.entry.name,
    type: FileType.TEXT,
    size: null,
    modified: modified !== '' ? modified : null,
    fingerprint: null,
    revision: null,
    extra,
  })
}

function statName(virtualKey: string, mountPrefix: string): string {
  const root = rstripSlash(mountPrefix) !== '' ? rstripSlash(mountPrefix) : '/'
  if (virtualKey === root) return '/'
  const stripped = rstripSlash(virtualKey)
  return stripped.split('/').pop() ?? '/'
}

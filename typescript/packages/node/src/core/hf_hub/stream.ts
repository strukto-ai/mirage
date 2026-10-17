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

import { recordStream } from '@struktoai/mirage-core/observe/context'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { hubStream, resolveUrl } from './client.ts'
import { REFUSED_STATUSES } from './constants.ts'
import { asRefusal } from './lookup.ts'
import { resolveEntry, rowToken } from './read.ts'

export async function* readStream(
  accessor: HfHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): AsyncIterable<Uint8Array> {
  const row = resolveEntry(path, entry)
  const raw = path.mountPath
  const url = resolveUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    accessor.revision,
    accessor.repoPath(raw),
  )
  const rec = recordStream('read', path.virtual, accessor.vfsName)
  const stamp = (headers: Record<string, string>): void => {
    if (rec !== null) rec.fingerprint = rowToken(row, headers.etag ?? '')
  }
  try {
    for await (const chunk of hubStream(accessor.account, url, stamp)) {
      if (rec !== null) rec.bytes += chunk.length
      yield chunk
    }
  } catch (err) {
    throw asRefusal(path, err, REFUSED_STATUSES)
  }
}

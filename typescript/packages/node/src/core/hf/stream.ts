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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/utils/errors'
import type { HfBucketsAccessor } from '../../accessor/hf.ts'
import { hubStream } from '../hf_hub/client.ts'
import { REFUSED_STATUSES } from '../hf_hub/constants.ts'
import { asRefusal } from '../hf_hub/lookup.ts'
import { readToken, resolveUrl } from './hub.ts'
import { isMissing, read } from './read.ts'

export async function rangeRead(
  accessor: HfBucketsAccessor,
  path: PathSpec,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return read(accessor, path, undefined, { offset: start, size: end - start })
}

/** Stream a bucket file from the Hub, stamped with its ETag. */
export async function* stream(
  accessor: HfBucketsAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const rel = path.mountPath
  if (rel.replace(/^\/+|\/+$/g, '') === '') throw eisdir(path)
  const rec = recordStream('read', path.virtual, accessor.vfsName)
  const stamp = (headers: Record<string, string>): void => {
    if (rec !== null) rec.fingerprint = readToken(headers.etag ?? '')
  }
  try {
    for await (const chunk of hubStream(accessor.token, resolveUrl(accessor, rel), stamp)) {
      if (rec !== null) rec.bytes += chunk.byteLength
      yield chunk
    }
  } catch (err) {
    if (isMissing(err)) throw enoent(path)
    throw asRefusal(path, err, REFUSED_STATUSES)
  }
}

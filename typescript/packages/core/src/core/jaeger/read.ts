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

import type { JaegerAccessor } from '../../accessor/jaeger.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { JaegerApiError, fetchOperations, fetchTrace, isTraceId } from './_client.ts'
import { assertService } from './readdir.ts'
import { detectScope } from './scope.ts'

const ENC = new TextEncoder()

function toJsonBytes(data: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(data, null, 2))
}

export async function read(
  accessor: JaegerAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const key = path.resourcePath
  if (key.split('/').some((p) => p.startsWith('.'))) throw enoent(path)

  const scope = detectScope(path)

  if (scope.level === 'operations') {
    const service = scope.service ?? ''
    await assertService(accessor, service, path)
    const operations = await fetchOperations(accessor.transport, service)
    return toJsonBytes(operations)
  }

  if (scope.level === 'trace') {
    const traceId = scope.traceId ?? ''
    // A malformed id cannot name an existing trace, so it is ENOENT rather
    // than the API's 400 "invalid length for TraceID".
    if (!isTraceId(traceId)) throw enoent(path)
    try {
      const trace = await fetchTrace(accessor.transport, traceId)
      return toJsonBytes(trace)
    } catch (err) {
      if (err instanceof JaegerApiError && err.status === 404) throw enoent(path)
      throw err
    }
  }

  throw enoent(path)
}

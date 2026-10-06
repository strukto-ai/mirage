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
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonBytes } from '../render/json.ts'
import { JaegerApiError, fetchOperations, fetchTrace } from './client.ts'
import { assertService } from './readdir.ts'
import { detectScope } from './scope.ts'

// Whether any span in the trace was emitted by the service. A trace is fetched
// by id from the global endpoint, so the id alone does not place it under the
// service directory it was addressed through. Membership is read from the
// trace's own process table rather than the service listing, which is windowed
// and limited and would hide a trace that really belongs.
function hasService(trace: unknown, service: string): boolean {
  if (trace === null || typeof trace !== 'object') return false
  const processes = (trace as { processes?: unknown }).processes
  if (processes === null || typeof processes !== 'object') return false
  return Object.values(processes as Record<string, unknown>).some(
    (p) =>
      p !== null &&
      typeof p === 'object' &&
      (p as { serviceName?: unknown }).serviceName === service,
  )
}

async function readOperations(
  accessor: JaegerAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const service = match.slots.service ?? ''
  await assertService(accessor, service, path.virtual)
  const operations = await fetchOperations(accessor.transport, service)
  return jsonBytes(operations)
}

async function readTrace(
  accessor: JaegerAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const service = match.slots.service ?? ''
  await assertService(accessor, service, path.virtual)
  let trace: unknown
  try {
    trace = await fetchTrace(accessor.transport, match.slots.trace_id ?? '')
  } catch (err) {
    if (err instanceof JaegerApiError && err.status === 404) throw enoent(path)
    throw err
  }
  // Reading by id would otherwise serve any trace through any service
  // directory, contradicting stat and ls for the same path.
  if (!hasService(trace, service)) throw enoent(path)
  return jsonBytes(trace)
}

export const read = makeRead(detectScope, {
  operations: readOperations,
  trace: readTrace,
})

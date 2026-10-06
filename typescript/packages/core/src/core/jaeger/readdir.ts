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
import { IndexEntry } from '../../cache/index/config.ts'
import { enoent } from '../../errors/fs.ts'
import { makeReaddir, type DirListing } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonBytes } from '../render/json.ts'
import { fetchOperations, fetchServices, fetchTraces, isTraceId } from './client.ts'
import { OPERATIONS_FILE, TOP_LEVEL_DIRS, detectScope } from './scope.ts'

/**
 * Throw ENOENT unless the service is known to Jaeger.
 *
 * The operations endpoint answers 200 with an empty list for a service that
 * was never seen, so an unknown service would otherwise look like an empty
 * directory instead of a missing one.
 */
export async function assertService(
  accessor: JaegerAccessor,
  service: string,
  virtual: string,
): Promise<void> {
  const services = await fetchServices(accessor.transport)
  if (!services.includes(service)) throw enoent(virtual)
}

export async function serviceGuard(
  accessor: JaegerAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  await assertService(accessor, match.slots.service ?? '', virtual)
}

async function listServices(
  accessor: JaegerAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const services = await fetchServices(accessor.transport)
  return services.map((service): [string, IndexEntry] => [
    service,
    new IndexEntry({
      id: service,
      name: service,
      resourceType: 'jaeger/service',
      vfsName: service,
    }),
  ])
}

async function listService(
  accessor: JaegerAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const service = match.slots.service ?? ''
  // One operations call per service directory actually entered: nothing in
  // the services listing carries operation names, so operations.json can only
  // be sized here, and only for services the caller opens.
  const operations = await fetchOperations(accessor.transport, service)
  return [
    [
      OPERATIONS_FILE,
      new IndexEntry({
        id: `${service}/operations`,
        name: OPERATIONS_FILE,
        resourceType: 'jaeger/operations',
        vfsName: OPERATIONS_FILE,
        size: jsonBytes(operations).byteLength,
      }),
    ],
    [
      'traces',
      new IndexEntry({
        id: `${service}/traces`,
        name: 'traces',
        resourceType: 'jaeger/traces_dir',
        vfsName: 'traces',
      }),
    ],
  ]
}

async function listTraces(accessor: JaegerAccessor, match: ScopeMatch): Promise<DirListing> {
  const service = match.slots.service ?? ''
  const opts: { limit: number; fromTimestamp?: string; toTimestamp?: string } = {
    limit: accessor.config.defaultTraceLimit ?? 100,
  }
  const from = accessor.config.defaultFromTimestamp
  if (from !== undefined && from !== '') opts.fromTimestamp = from
  const to = accessor.config.defaultToTimestamp
  if (to !== undefined && to !== '') opts.toTimestamp = to
  const traces = await fetchTraces(accessor.transport, service, opts)
  const entries: [string, IndexEntry][] = []
  for (const trace of traces) {
    const traceId = typeof trace.traceID === 'string' ? trace.traceID : ''
    if (!isTraceId(traceId)) continue
    const filename = `${traceId}.json`
    // The search endpoint returns complete trace documents, so the rendered
    // size is free here. Span order may differ from the by-id fetch, but
    // reordering the same spans leaves the byte length equal.
    entries.push([
      filename,
      new IndexEntry({
        id: traceId,
        name: traceId,
        resourceType: 'jaeger/trace',
        vfsName: filename,
        size: jsonBytes(trace).byteLength,
      }),
    ])
  }
  // The newest defaultTraceLimit traces: one that ages out of the page is
  // still in Jaeger, so the listing evicts nothing.
  return { entries, seeds: {}, window: true }
}

export const readdir = makeReaddir<JaegerAccessor>(detectScope, {
  listers: {
    services: listServices,
    service: listService,
    traces: listTraces,
  },
  staticRoot: TOP_LEVEL_DIRS,
  guards: {
    service: serviceGuard,
    traces: serviceGuard,
  },
})

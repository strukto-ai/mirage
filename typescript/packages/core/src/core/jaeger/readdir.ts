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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { fetchOperations, fetchServices, fetchTraces, isTraceId } from './_client.ts'
import { jaegerJsonBytes } from './render.ts'
import { JAEGER_OPERATIONS_FILE, JAEGER_TOP_LEVEL_DIRS, detectScope } from './scope.ts'

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

/**
 * Throw ENOENT unless the service is known to Jaeger.
 *
 * The operations endpoint answers 200 with an empty list for a service that was
 * never seen, so an unknown service would otherwise look like an empty
 * directory instead of a missing one.
 */
export async function assertService(
  accessor: JaegerAccessor,
  service: string,
  path: PathSpec,
): Promise<void> {
  const services = await fetchServices(accessor.transport)
  if (!services.includes(service)) throw enoent(path)
}

async function readdirService(
  accessor: JaegerAccessor,
  service: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  // One operations call per service directory actually entered: nothing in
  // the services listing carries operation names, so operations.json can only
  // be sized here, and only for services the caller opens.
  const operations = await fetchOperations(accessor.transport, service)
  const entries: [string, IndexEntry][] = [
    [
      JAEGER_OPERATIONS_FILE,
      new IndexEntry({
        id: `${service}/operations`,
        name: JAEGER_OPERATIONS_FILE,
        resourceType: 'jaeger/operations',
        vfsName: JAEGER_OPERATIONS_FILE,
        size: jaegerJsonBytes(operations).byteLength,
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
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return entries.map(([name]) => `${prefix}/services/${service}/${name}`)
}

async function readdirServices(
  accessor: JaegerAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const services = await fetchServices(accessor.transport)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const service of services) {
    entries.push([
      service,
      new IndexEntry({
        id: service,
        name: service,
        resourceType: 'jaeger/service',
        vfsName: service,
      }),
    ])
    names.push(`${prefix}/services/${service}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirTraces(
  accessor: JaegerAccessor,
  service: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const opts: { limit: number; fromTimestamp?: string; toTimestamp?: string } = {
    limit: accessor.config.defaultTraceLimit ?? 100,
  }
  const from = accessor.config.defaultFromTimestamp
  if (from !== undefined && from !== '') opts.fromTimestamp = from
  const to = accessor.config.defaultToTimestamp
  if (to !== undefined && to !== '') opts.toTimestamp = to
  const traces = await fetchTraces(accessor.transport, service, opts)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
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
        size: jaegerJsonBytes(trace).byteLength,
      }),
    ])
    names.push(`${prefix}/services/${service}/traces/${filename}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

export async function readdir(
  accessor: JaegerAccessor,
  pathSpec: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.resourcePath)
  const path = (pathSpec.pattern !== null ? pathSpec.dir : pathSpec).mountPath
  const key = stripSlash(path)

  if (key !== '' && key.split('/').some((p) => p.startsWith('.'))) throw enoent(pathSpec)

  const virtualKey = makeVirtualKey(prefix, key)
  const scope = detectScope(path)

  if (scope.level === 'root') return JAEGER_TOP_LEVEL_DIRS.map((d) => `${prefix}/${d}`)

  if (scope.level === 'services') {
    return readdirServices(accessor, virtualKey, index, prefix)
  }

  if (scope.level === 'service') {
    const service = scope.service ?? ''
    await assertService(accessor, service, pathSpec)
    return readdirService(accessor, service, virtualKey, index, prefix)
  }

  if (scope.level === 'traces') {
    const service = scope.service ?? ''
    await assertService(accessor, service, pathSpec)
    return readdirTraces(accessor, service, virtualKey, index, prefix)
  }

  throw enoent(pathSpec)
}

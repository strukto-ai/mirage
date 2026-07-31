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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { isTraceId } from './_client.ts'
import { assertService, readdir } from './readdir.ts'
import { JAEGER_OPERATIONS_FILE, detectScope } from './scope.ts'

function basenameOf(entry: string): string {
  const trimmed = rstripSlash(entry)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * Throw ENOENT unless the path appears in its parent's listing.
 *
 * Every path shape jaeger serves is recognizable from the text alone, but a
 * recognizable shape is not evidence the trace exists. The parent listing is
 * index-cached, so this costs one listing per directory rather than one API
 * call per stat.
 */
async function assertListed(
  accessor: JaegerAccessor,
  path: PathSpec,
  prefix: string,
  index?: IndexCacheStore,
): Promise<void> {
  const virtual = rstripSlash(path.virtual)
  const parentVirtual = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  const entries = await readdir(
    accessor,
    new PathSpec({
      virtual: parentVirtual,
      directory: parentVirtual,
      resolved: false,
      resourcePath: mountKey(parentVirtual, prefix),
    }),
    index,
  )
  const names = new Set(entries.map(basenameOf))
  if (!names.has(basenameOf(path.resourcePath))) throw enoent(path)
}

export async function stat(
  accessor: JaegerAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const key = path.resourcePath
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)

  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  if (key.split('/').some((p) => p.startsWith('.'))) throw enoent(path)

  const scope = detectScope(path)

  if (scope.level === 'services') {
    return new FileStat({ name: 'services', type: FileType.DIRECTORY })
  }

  if (scope.level === 'service') {
    const service = scope.service ?? ''
    await assertService(accessor, service, path)
    return new FileStat({
      name: service,
      type: FileType.DIRECTORY,
      extra: { service },
    })
  }

  if (scope.level === 'traces') {
    await assertService(accessor, scope.service ?? '', path)
    return new FileStat({ name: 'traces', type: FileType.DIRECTORY })
  }

  if (scope.level === 'operations') {
    // The service readdir stores the rendered document's byte length, so the
    // listing that just proved existence also carries the size.
    await assertListed(accessor, path, prefix, index)
    let size: number | null = null
    if (index !== undefined) {
      const lookup = await index.get(rstripSlash(path.virtual))
      size = lookup.entry?.size ?? null
    }
    return new FileStat({
      name: JAEGER_OPERATIONS_FILE,
      ...(size !== null ? { size } : {}),
      type: FileType.JSON,
    })
  }

  if (scope.level === 'trace') {
    const traceId = scope.traceId ?? ''
    if (!isTraceId(traceId)) throw enoent(path)
    await assertListed(accessor, path, prefix, index)
    // The traces readdir stores the rendered document's byte length, so the
    // listing that just proved existence also carries the size.
    let size: number | null = null
    if (index !== undefined) {
      const lookup = await index.get(rstripSlash(path.virtual))
      size = lookup.entry?.size ?? null
    }
    return new FileStat({
      name: `${traceId}.json`,
      type: FileType.JSON,
      size,
      extra: { trace_id: traceId },
    })
  }

  throw enoent(path)
}

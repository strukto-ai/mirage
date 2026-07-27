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

import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'

export const JAEGER_OPERATIONS_FILE = 'operations.json'
export const JAEGER_TOP_LEVEL_DIRS = ['services'] as const

export interface JaegerScope {
  level: string
  service: string | null
  traceId: string | null
  resourcePath: string
}

function scope(
  level: string,
  resourcePath: string,
  service: string | null = null,
  traceId: string | null = null,
): JaegerScope {
  return { level, service, traceId, resourcePath }
}

/**
 * Classify a resource-relative path into a jaeger tree position.
 *
 * The tree is service-scoped because Jaeger's search API requires a service:
 * there is no endpoint that lists every trace.
 */
export function detectScope(path: PathSpec | string): JaegerScope {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const key = stripSlash(raw)

  if (key === '') return scope('root', raw)

  const parts = key.split('/')
  if (parts[0] !== 'services') return scope('unknown', raw)
  if (parts.length === 1) return scope('services', raw)

  const service = parts[1] ?? ''

  if (parts.length === 2) return scope('service', raw, service)
  if (parts.length === 3 && parts[2] === JAEGER_OPERATIONS_FILE) {
    return scope('operations', raw, service)
  }
  if (parts.length === 3 && parts[2] === 'traces') return scope('traces', raw, service)
  if (parts.length === 4 && parts[2] === 'traces' && (parts[3] ?? '').endsWith('.json')) {
    const name = parts[3] ?? ''
    return scope('trace', raw, service, name.slice(0, -'.json'.length))
  }

  return scope('unknown', raw)
}

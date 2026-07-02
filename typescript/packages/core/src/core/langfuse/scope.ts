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

export interface LangfuseScope {
  level: string
  resourceType: string | null
  resourceId: string | null
  subResource: string | null
  resourcePath: string
}

const TOP_LEVEL = new Set(['traces', 'sessions', 'prompts', 'datasets'])

function stripIdSuffix(name: string): string {
  const dot = name.indexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

export function detectScope(path: PathSpec | string): LangfuseScope {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const key = stripSlash(raw)

  if (key === '') {
    return {
      level: 'root',
      resourceType: null,
      resourceId: null,
      subResource: null,
      resourcePath: '/',
    }
  }

  const parts = key.split('/')
  const head = parts[0] ?? ''

  if (TOP_LEVEL.has(head)) {
    if (parts.length === 1) {
      return {
        level: head,
        resourceType: head,
        resourceId: null,
        subResource: null,
        resourcePath: raw,
      }
    }
    if (parts.length === 2) {
      const second = parts[1] ?? ''
      if (second.endsWith('.json') || second.endsWith('.jsonl')) {
        return {
          level: 'file',
          resourceType: head,
          resourceId: stripIdSuffix(second),
          subResource: null,
          resourcePath: raw,
        }
      }
      return {
        level: head,
        resourceType: head,
        resourceId: second,
        subResource: null,
        resourcePath: raw,
      }
    }
    if (parts.length === 3) {
      return {
        level: 'file',
        resourceType: head,
        resourceId: parts[1] ?? '',
        subResource: parts[2] ?? '',
        resourcePath: raw,
      }
    }
    if (parts.length === 4) {
      return {
        level: 'file',
        resourceType: head,
        resourceId: parts[1] ?? '',
        subResource: parts[3] ?? '',
        resourcePath: raw,
      }
    }
  }

  return {
    level: 'root',
    resourceType: null,
    resourceId: null,
    subResource: null,
    resourcePath: raw,
  }
}

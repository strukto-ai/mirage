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

import type { PathSpec } from '@struktoai/mirage-core'
import { stripSlash } from '@struktoai/mirage-core'

export interface EmailScope {
  useNative: boolean
  folder: string | null
  resourcePath: string
}

export function detectScope(path: PathSpec): EmailScope {
  const key = stripSlash(path.mountPath)
  if (key === '') {
    return { useNative: false, folder: null, resourcePath: '/' }
  }
  const parts = key.split('/').filter((s) => s !== '')
  if (parts.length === 0) {
    return { useNative: false, folder: null, resourcePath: '/' }
  }
  if (key.endsWith('.email.json')) {
    return { useNative: false, folder: parts[0] ?? null, resourcePath: key }
  }
  if (parts.length <= 2) {
    return { useNative: true, folder: parts[0] ?? null, resourcePath: key }
  }
  return { useNative: false, folder: parts[0] ?? null, resourcePath: key }
}

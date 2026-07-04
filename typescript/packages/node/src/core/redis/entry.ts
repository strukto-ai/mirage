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

import { IndexEntry } from '@struktoai/mirage-core'

export const RedisResourceType = Object.freeze({
  FILE: 'file',
  FOLDER: 'folder',
} as const)

export type RedisResourceType = (typeof RedisResourceType)[keyof typeof RedisResourceType]

export class RedisIndexEntry extends IndexEntry {
  // size defaults to null, not 0: a readdir knows a key exists but not
  // its length, and a lying 0 would be trusted by index-first size
  // lookups (provision estimates) over a real stat.
  static file(path: string, size: number | null = null): RedisIndexEntry {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return new RedisIndexEntry({
      id: path,
      name,
      resourceType: RedisResourceType.FILE,
      vfsName: name,
      size,
    })
  }

  static folder(path: string): RedisIndexEntry {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return new RedisIndexEntry({
      id: path,
      name,
      resourceType: RedisResourceType.FOLDER,
      vfsName: name,
    })
  }
}

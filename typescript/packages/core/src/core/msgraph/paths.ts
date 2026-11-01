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

import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GraphError, graphGet } from './client.ts'
import type { resolveMsGraphConfig } from './config.ts'

interface DrivePath {
  readonly path: string
  readonly virtual: string
  itemAt(path: string, action?: string): string
}

/** Validate caller-controlled drive components; configured root components are infrastructure. */
export async function checkItem(
  config: ReturnType<typeof resolveMsGraphConfig>,
  loc: DrivePath,
  virtual?: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const parts = stripSlash(loc.path) === '' ? [] : stripSlash(loc.path).split('/')
  const visible = stripSlash(loc.virtual) === '' ? [] : stripSlash(loc.virtual).split('/')
  const start = Math.max(0, parts.length - visible.length)
  let entry: Record<string, unknown> | null = null
  for (let i = start; i < parts.length; i++) {
    try {
      entry = await graphGet(
        config,
        loc.itemAt(parts.slice(0, i + 1).join('/')),
        i === parts.length - 1 ? params : undefined,
      )
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null
      throw err
    }
    if (typeof entry.name === 'string' && entry.name !== parts[i]) {
      throw enoent(virtual ?? '/' + stripSlash(loc.virtual))
    }
  }
  return entry
}

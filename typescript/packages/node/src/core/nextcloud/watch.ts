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

import {
  ListingDeltaHook,
  mountPrefixOf,
  statFingerprint,
  stripSlash,
  type DeltaHook,
  type PathSpec,
  type WalkEntry,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound } from './util.ts'

export class NextcloudWalk {
  private readonly accessor: NextcloudAccessor

  constructor(accessor: NextcloudAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const base = stripSlash(root.resourcePath)
    const listPath = base !== '' ? `${base}/` : '/'
    const operator = await this.accessor.operator()
    let entries
    try {
      entries = await operator.list(listPath, { recursive: true })
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    for (const entry of entries) {
      const relative = entry.path()
      if (relative === '' || relative === listPath) continue
      const metadata = entry.metadata()
      const isDir = relative.endsWith('/') || metadata.isDirectory()
      const resourcePath = stripSlash(relative)
      const virtual = prefix !== '' ? `${prefix}/${resourcePath}` : `/${resourcePath}`
      if (isDir) {
        yield { virtual, isDir: true, fingerprint: null }
        continue
      }
      const modified = metadata.lastModified
      const size = metadata.contentLength === null ? null : Number(metadata.contentLength)
      yield {
        virtual,
        isDir: false,
        fingerprint: statFingerprint(metadata.etag, modified, size),
        size,
        modified,
      }
    }
  }
}

export function buildDeltaHook(accessor: NextcloudAccessor): DeltaHook {
  const walk = new NextcloudWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}

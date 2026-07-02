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

import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { loadS3Module, rawPathOf, s3Prefix, stripKeyPrefix, withClient } from './_client.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { buildTree, emitStartPath, keep, startBasename } from '../../commands/builtin/findEval.ts'

export async function find(
  accessor: S3Accessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const { ListObjectsV2Command } = await loadS3Module(accessor.config)
  const raw = rawPathOf(path)
  const startName = startBasename(path.virtual)
  const pfx = s3Prefix(raw, accessor.config)
  const results: string[] = []
  const seen = { descendant: false, marker: false }
  const empty = options.empty === true
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  await withClient(accessor.config, async (client) => {
    let continuationToken: string | undefined
    do {
      const input: Record<string, unknown> = {
        Bucket: accessor.config.bucket,
        Prefix: pfx,
      }
      if (continuationToken !== undefined) input.ContinuationToken = continuationToken
      const resp = (await client.send(new ListObjectsV2Command(input))) as {
        Contents?: { Key?: string; Size?: number; LastModified?: Date }[]
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      for (const obj of resp.Contents ?? []) {
        const key = obj.Key
        if (key === undefined) continue
        if (key === pfx) {
          seen.marker = true
          continue
        }
        seen.descendant = true
        const relative = key.slice(pfx.length)
        const depth = (relative.match(/\//g) ?? []).length + 1
        if (
          options.maxDepth !== null &&
          options.maxDepth !== undefined &&
          depth > options.maxDepth
        ) {
          continue
        }
        const isDir = key.endsWith('/')
        const normKey = isDir ? key.slice(0, -1) : key
        const entryName = normKey.split('/').pop() ?? ''
        const fullPath = rstripSlash('/' + stripKeyPrefix(key, accessor.config)) || '/'
        const size = obj.Size ?? 0
        const isEmpty = !empty ? null : isDir ? false : size === 0
        if (
          !keep(
            { key: fullPath, name: entryName, kind: isDir ? 'd' : 'f', depth, isEmpty },
            tree,
            options.minDepth,
          )
        ) {
          continue
        }
        if (!isDir) {
          if (options.minSize !== null && options.minSize !== undefined && size < options.minSize) {
            continue
          }
          if (options.maxSize !== null && options.maxSize !== undefined && size > options.maxSize) {
            continue
          }
        }
        results.push(fullPath)
      }
      continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  })
  const rootKey = rstripSlash('/' + stripKeyPrefix(pfx, accessor.config)) || '/'
  if (seen.descendant || seen.marker) {
    emitStartPath(results, rootKey, startName, {
      kind: 'd',
      isEmpty: empty ? false : null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
    })
  }
  return results.sort()
}

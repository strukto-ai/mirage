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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, loadS3Module, s3Prefix } from './_client.ts'
import { rstripSlash } from '../../utils/slash.ts'

export async function readdir(
  accessor: S3Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const original = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  // When called from resolveGlob with a pattern, use path.directory for the
  // listing; direct callers pass pattern=null so we use path.virtual.
  const virtual = path.pattern !== null ? path.directory : original
  const rawPath =
    prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual

  // Fast path: the index cache may already have this directory populated
  // from a previous readdir. Mirror Python's mirage/core/s3/readdir.py.
  const virtualKey = rawPath === '/' ? '/' : rstripSlash(rawPath) || '/'
  const rawFullKey = prefix !== '' ? `${prefix}${virtualKey}` : virtualKey
  const fullVirtualKey = rstripSlash(rawFullKey) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(fullVirtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }

  const { config } = accessor
  const { ListObjectsV2Command } = await loadS3Module(config)
  const client = await createS3Client(config)
  const send = (
    client as unknown as {
      send: (cmd: unknown) => Promise<Record<string, unknown>>
    }
  ).send.bind(client)

  const entries = new Set<string>()
  const dirKeys = new Set<string>()
  const objects = new Map<
    string,
    { size: number | null; etag: string; lastModified: Date | string | undefined }
  >()
  const s3Pfx = s3Prefix(rawPath, config)
  let continuationToken: string | undefined
  try {
    do {
      const input: Record<string, unknown> = {
        Bucket: config.bucket,
        Prefix: s3Pfx,
        Delimiter: '/',
      }
      if (continuationToken !== undefined) input.ContinuationToken = continuationToken
      const resp = (await send(new ListObjectsV2Command(input))) as {
        CommonPrefixes?: { Prefix?: string }[]
        Contents?: { Key?: string; Size?: number; ETag?: string; LastModified?: Date | string }[]
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      for (const cp of resp.CommonPrefixes ?? []) {
        const p = cp.Prefix
        if (p === undefined) continue
        const name = rstripSlash(p.slice(s3Pfx.length))
        if (name !== '') {
          entries.add(name)
          dirKeys.add(name)
        }
      }
      for (const obj of resp.Contents ?? []) {
        const k = obj.Key
        if (k === undefined || k === s3Pfx) continue
        const name = k.slice(s3Pfx.length)
        if (name !== '' && !name.includes('/')) {
          entries.add(name)
          objects.set(name, {
            size: obj.Size ?? null,
            etag: obj.ETag ?? '',
            lastModified: obj.LastModified,
          })
        }
      }
      continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
  // Align with RAM/Disk: return fully-qualified paths (mount prefix + directory + name)
  // so commands like `ls` can stat each entry without re-resolving.
  const mountPrefix = prefix
  const virtualDir = rawPath === '' || rawPath === '/' ? '/' : rstripSlash(rawPath) + '/'
  const sortedNames = [...entries].sort()
  const virtualEntries = sortedNames.map((name) => `${mountPrefix}${virtualDir}${name}`)

  // Populate the index as a side-effect so future stat()/readdir() calls
  // can hit the fast path. Mirrors Python's mirage/core/s3/readdir.py.
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = sortedNames.map((name) => {
      if (dirKeys.has(name)) {
        return [
          name,
          new IndexEntry({
            id: `${mountPrefix}${virtualDir}${name}/`,
            name,
            resourceType: ResourceType.FOLDER,
            vfsName: name,
          }),
        ]
      }
      const obj = objects.get(name)
      const modified = obj?.lastModified
      const remoteTime =
        modified instanceof Date
          ? modified.toISOString()
          : typeof modified === 'string'
            ? modified
            : ''
      return [
        name,
        new IndexEntry({
          id: `${mountPrefix}${virtualDir}${name}`,
          name,
          resourceType: ResourceType.FILE,
          vfsName: name,
          size: obj?.size ?? null,
          remoteTime,
        }),
      ]
    })
    await index.setDir(fullVirtualKey, indexEntries)
  }

  return virtualEntries
}

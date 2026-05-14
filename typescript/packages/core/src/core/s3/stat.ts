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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { guessType } from '../../utils/filetype.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isNotFoundError, loadS3Module, s3Key } from './_client.ts'

function basename(path: string): string {
  const stripped = path.replace(/\/+$/, '')
  const idx = stripped.lastIndexOf('/')
  return idx >= 0 ? stripped.slice(idx + 1) : stripped
}

export async function stat(
  accessor: S3Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const original = path.original
  const prefix = path.prefix
  const rawPath =
    prefix !== '' && original.startsWith(prefix) ? original.slice(prefix.length) || '/' : original
  const stripped = rawPath.replace(/^\/+|\/+$/g, '')
  if (stripped === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }

  // A trailing slash ("/s3/csv/") signals the caller treats it as a
  // directory. S3 allows both an object at key "csv" AND a prefix "csv/..."
  // to coexist — without this hint we'd return the file and commands like
  // `ls /s3/csv/` would list one entry (the file itself) instead of the
  // directory's contents.
  const hintsDirectory = /\/+$/.test(rawPath)

  // Fast path: check the index cache populated by readdir(). Matches
  // Python's mirage/core/s3/stat.py fast-path. Saves a network round-trip
  // for paths the agent has already listed.
  if (index !== undefined) {
    const virtualKey = prefix !== '' ? `${prefix}/${stripped}` : '/' + stripped
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
      if (entry.resourceType === 'folder') {
        return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
      }
      return new FileStat({
        name: entry.name,
        size: entry.size ?? null,
        type: guessType(entry.name),
      })
    }
    // Parent was already listed and didn't include this path — it doesn't exist.
    // Avoids speculative network calls for shell-probed paths like .git, HEAD, .hg.
    const parent = virtualKey.replace(/\/[^/]*$/, '') || '/'
    const parentListing = await index.listDir(parent)
    if (parentListing.entries !== undefined && parentListing.entries !== null) {
      const e = new Error(`S3 object not found: ${rawPath}`) as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }
  }

  const { config } = accessor
  const { HeadObjectCommand, ListObjectsV2Command } = await loadS3Module(config)
  const client = await createS3Client(config)
  const send = (
    client as unknown as {
      send: (cmd: unknown) => Promise<Record<string, unknown>>
    }
  ).send.bind(client)

  try {
    if (hintsDirectory) {
      // Skip HeadObject — caller already said it's a directory.
      const pfx = s3Key(rawPath).replace(/\/+$/, '') + '/'
      const listResp = (await send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: pfx,
          Delimiter: '/',
          MaxKeys: 1,
        }),
      )) as { CommonPrefixes?: unknown[]; Contents?: unknown[] }
      if ((listResp.CommonPrefixes?.length ?? 0) > 0 || (listResp.Contents?.length ?? 0) > 0) {
        return new FileStat({ name: basename(rawPath) || '/', type: FileType.DIRECTORY })
      }
      const e = new Error(`S3 object not found: ${rawPath}`) as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }

    try {
      const resp = (await send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: s3Key(rawPath) }),
      )) as {
        ContentLength?: number
        LastModified?: Date
        ETag?: string
        VersionId?: string
      }
      const modified = resp.LastModified?.toISOString() ?? null
      const etag = resp.ETag?.replace(/^"|"$/g, '') ?? ''
      let revision = resp.VersionId ?? null
      if (revision === 'null') revision = null
      return new FileStat({
        name: basename(rawPath),
        size: resp.ContentLength ?? null,
        modified,
        fingerprint: etag !== '' ? etag : null,
        revision,
        type: guessType(rawPath),
        extra: etag !== '' ? { etag } : {},
      })
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }

    // Not a file — probe for directory prefix.
    const pfx = s3Key(rawPath).replace(/\/+$/, '') + '/'
    const listResp = (await send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: pfx,
        Delimiter: '/',
        MaxKeys: 1,
      }),
    )) as { CommonPrefixes?: unknown[]; Contents?: unknown[] }
    if ((listResp.CommonPrefixes?.length ?? 0) > 0 || (listResp.Contents?.length ?? 0) > 0) {
      return new FileStat({ name: basename(rawPath) || '/', type: FileType.DIRECTORY })
    }

    const e = new Error(`S3 object not found: ${rawPath}`) as Error & { code: string }
    e.code = 'ENOENT'
    throw e
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
}

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

import { readTar, writeTar, type TarEntry } from '../../commands/builtin/tar_helper.ts'
import { gzip, gunzip } from '../../utils/compress.ts'
import { resolveManifest } from './manifest.ts'
import { isSafeBlobPath } from './utils.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const MANIFEST_NAME = 'manifest.json'

export type CompressMode = null | 'gz'

export async function writeSnapshotTar(
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array>,
  compress: CompressMode = null,
): Promise<Uint8Array> {
  const manifestBytes = ENC.encode(JSON.stringify(manifest, null, 2))
  const entries: TarEntry[] = [{ name: MANIFEST_NAME, data: manifestBytes, isFile: true }]
  for (const [path, data] of Object.entries(blobs)) {
    entries.push({ name: path, data, isFile: true })
  }
  const tarBytes = await writeTar(entries)
  if (compress === 'gz') return gzip(tarBytes)
  return tarBytes
}

export async function readSnapshotTar(
  data: Uint8Array,
  compress: CompressMode = null,
): Promise<unknown> {
  const tarBytes = compress === 'gz' ? await gunzip(data) : data
  const entries = await readTar(tarBytes)
  const byName = new Map<string, Uint8Array>()
  for (const e of entries) byName.set(e.name, e.data)
  const manifestRaw = byName.get(MANIFEST_NAME)
  if (manifestRaw === undefined) {
    throw new Error(`${MANIFEST_NAME} missing or unreadable`)
  }
  const manifest = JSON.parse(DEC.decode(manifestRaw)) as Record<string, unknown>
  const reader = (blobPath: string): Uint8Array => {
    if (!isSafeBlobPath(blobPath)) {
      throw new Error(`Unsafe blob path: ${String(blobPath)}`)
    }
    const blob = byName.get(blobPath)
    if (blob === undefined) throw new Error(`Manifest references missing blob: ${blobPath}`)
    return blob
  }
  return resolveManifest(manifest, reader)
}

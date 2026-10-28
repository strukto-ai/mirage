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

import { S3Accessor } from '../../accessor/s3.ts'
import { read as readObject } from '../../core/s3/read.ts'
import { write as writeObject } from '../../core/s3/write.ts'
import { PathSpec } from '../../types.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { readFileBytes } from './fs.ts'
import { splitManifestAndBlobs } from './manifest.ts'
import { toStateDict, type WorkspaceLike } from './state.ts'
import { readSnapshotTar, readTar, writeSnapshotTar, writeTar } from './tar_io.ts'

function keyPath(key: string): PathSpec {
  return PathSpec.fromStrPath(`/${key.replace(/^\/+/, '')}`)
}

/**
 * Serialize a workspace to a tar while new lines wait (see
 * `Workspace.quiesced`). With a target it streams to that file, or with
 * `s3` it goes to that key of an S3-like store, under its `key_prefix`.
 *
 * @returns The tar's bytes, or with a file target its size.
 */
export async function snapshot(
  ws: WorkspaceLike,
  target?: string,
  options: { s3?: S3Config } = {},
): Promise<Uint8Array | number> {
  const tar = await ws.quiesced(async () => {
    const state = await toStateDict(ws)
    const [manifest, blobs] = splitManifestAndBlobs(state as unknown as Record<string, unknown>)
    if (target !== undefined && options.s3 === undefined) {
      return writeTar(target, manifest, blobs)
    }
    return writeSnapshotTar(manifest, blobs)
  })
  if (target !== undefined && options.s3 !== undefined && typeof tar !== 'number') {
    await writeObject(new S3Accessor(options.s3), keyPath(target), tar)
  }
  return tar
}

/**
 * Read a snapshot tar back into a state dict: a file, the bytes
 * themselves, or with `s3` a key of an S3-like store. With `staging`, a
 * file's disk mount files are extracted under that directory and come
 * back as host paths rather than bytes.
 * `maxBytes` limits expanded and restored bytes; `maxEncodedBytes`
 * independently limits the encoded object fetched from S3.
 */
export async function readSnapshot(
  source: string | Uint8Array,
  options: { s3?: S3Config; staging?: string; maxBytes?: number; maxEncodedBytes?: number } = {},
): Promise<unknown> {
  if (typeof source !== 'string') return readSnapshotTar(source, null, options.maxBytes)
  if (options.s3 !== undefined) {
    const data = await readObject(new S3Accessor(options.s3), keyPath(source), {
      ...(options.maxEncodedBytes !== undefined ? { size: options.maxEncodedBytes + 1 } : {}),
    })
    if (options.maxEncodedBytes !== undefined && data.byteLength > options.maxEncodedBytes) {
      throw new Error('snapshot exceeds encoded size limit')
    }
    return readSnapshotTar(data, null, options.maxBytes)
  }
  if (options.staging !== undefined) return readTar(source, options.staging, options.maxBytes)
  return readSnapshotTar(await readFileBytes(source), null, options.maxBytes)
}

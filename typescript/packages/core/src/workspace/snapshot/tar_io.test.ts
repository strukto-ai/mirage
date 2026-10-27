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

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VFSName } from '../../types.ts'
import { MountKey, StateKey, VFSStateKey } from './keys.ts'
import {
  readSnapshotTar,
  readTar as readFileTar,
  writeSnapshotTar,
  writeTar as writeFileTar,
} from './tar_io.ts'
import { BLOB_REF_KEY } from './utils.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

/** One ustar member and the archive's end, as another archiver writes them. */
function tarOf(name: string, text: string): Uint8Array {
  const body = ENC.encode(text)
  const out = new Uint8Array(512 + Math.ceil(body.byteLength / 512) * 512 + 1024)
  out.set(ENC.encode(name), 0)
  out.set(ENC.encode(`${body.byteLength.toString(8).padStart(11, '0')}\0`), 124)
  out.fill(32, 148, 156)
  out[156] = 48
  out.set(ENC.encode('ustar\x0000'), 257)
  const sum = out.subarray(0, 512).reduce((total, byte) => total + byte, 0)
  out.set(ENC.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
  out.set(body, 512)
  return out
}

describe('writeSnapshotTar / readSnapshotTar', () => {
  it('roundtrips a manifest with blobs', async () => {
    const manifest = {
      version: 2,
      mounts: [{ index: 0, prefix: '/m' }],
      cache: { limit: 0, entries: [] },
    }
    const blob = ENC.encode('hello')
    const blobs = { 'mounts/0/files/0.bin': blob }
    const tarBytes = await writeSnapshotTar(manifest as unknown as Record<string, unknown>, blobs)
    const resolved = (await readSnapshotTar(tarBytes)) as Record<string, unknown>
    expect(resolved.version).toBe(2)
    expect(resolved.mounts).toEqual([{ index: 0, prefix: '/m' }])
  })

  it('writes valid JSON as manifest.json inside the tar', async () => {
    const manifest = { version: 2, mounts: [], cache: { limit: 0, entries: [] } }
    const tarBytes = await writeSnapshotTar(manifest as Record<string, unknown>, {})
    expect(DEC.decode(tarBytes.subarray(0, 14))).toBe('manifest.json\0')
    const size = Number.parseInt(DEC.decode(tarBytes.subarray(124, 135)), 8)
    const parsed = JSON.parse(DEC.decode(tarBytes.subarray(512, 512 + size))) as Record<
      string,
      unknown
    >
    expect(parsed.version).toBe(2)
    expect(parsed).toHaveProperty('mounts')
    expect(parsed).toHaveProperty('cache')
  })

  it('supports gzip compression roundtrip', async () => {
    const manifest = { version: 2, mounts: [], cache: { limit: 0, entries: [] } }
    const tarBytes = await writeSnapshotTar(manifest as Record<string, unknown>, {}, 'gz')
    const resolved = (await readSnapshotTar(tarBytes, 'gz')) as Record<string, unknown>
    expect(resolved.version).toBe(2)
  })
})

describe('readSnapshotTar path-traversal defense', () => {
  it('rejects manifest referencing blob with parent traversal', async () => {
    const manifest = {
      version: 2,
      mounts: [
        {
          index: 0,
          prefix: '/m',
          vfs_state: {
            type: 'ram',
            files: { '/x': { [BLOB_REF_KEY]: '../../etc/passwd' } },
          },
        },
      ],
      cache: { limit: 0, entries: [] },
    }
    const tarBytes = tarOf('manifest.json', JSON.stringify(manifest))
    await expect(readSnapshotTar(tarBytes)).rejects.toThrow(/Unsafe blob path/)
  })

  it('rejects manifest referencing absolute blob path', async () => {
    const manifest = {
      version: 2,
      mounts: [
        {
          index: 0,
          prefix: '/m',
          vfs_state: {
            type: 'ram',
            files: { '/x': { [BLOB_REF_KEY]: '/abs/path' } },
          },
        },
      ],
      cache: { limit: 0, entries: [] },
    }
    const tarBytes = tarOf('manifest.json', JSON.stringify(manifest))
    await expect(readSnapshotTar(tarBytes)).rejects.toThrow(/Unsafe blob path/)
  })

  it('throws when manifest.json is missing from the tar', async () => {
    const tarBytes = tarOf('other.txt', 'x')
    await expect(readSnapshotTar(tarBytes)).rejects.toThrow(/manifest\.json/)
  })
})

describe('snapshot tars of disk files', () => {
  const diskManifest = (blob: string): Record<string, unknown> => ({
    [StateKey.MOUNTS]: [
      {
        [MountKey.VFS_STATE]: {
          [VFSStateKey.TYPE]: VFSName.DISK,
          [VFSStateKey.FILES]: { f: { [BLOB_REF_KEY]: blob } },
        },
      },
    ],
  })

  it('refuses a captured file replaced by a link', async () => {
    // The tar reads a disk file after the state named it, streamed or in
    // memory; a link put in its place since must not carry a host file in.
    const dir = await mkdtemp(join(tmpdir(), 'mirage-tar-'))
    try {
      const secret = join(dir, 'secret')
      await writeFile(secret, 'host')
      const captured = join(dir, 'f')
      await symlink(secret, captured)
      await expect(
        writeFileTar(join(dir, 's.tar'), diskManifest('b/f'), { 'b/f': captured }),
      ).rejects.toThrow()
      await expect(writeSnapshotTar(diskManifest('b/f'), { 'b/f': captured })).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads back a blob path tar spells otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-tar-'))
    try {
      const blobs = { './b//f': ENC.encode('data') }
      const tarBytes = await writeSnapshotTar({ k: { [BLOB_REF_KEY]: './b//f' } }, blobs)
      expect(await readSnapshotTar(tarBytes)).toEqual({ k: ENC.encode('data') })
      const tar = join(dir, 's.tar')
      await writeFileTar(tar, diskManifest('./b//f'), blobs)
      const staging = join(dir, 'staging')
      await mkdir(staging)
      const state = (await readFileTar(tar, staging)) as Record<string, unknown>
      const mount = (state[StateKey.MOUNTS] as Record<string, Record<string, unknown>>[])[0]
      const files = mount?.[MountKey.VFS_STATE]?.[VFSStateKey.FILES] as Record<string, string>
      expect(DEC.decode(await readFile(files.f ?? ''))).toBe('data')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a staged blob inside the staging directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-tar-'))
    try {
      const tar = join(dir, 's.tar')
      await writeFileTar(tar, diskManifest('b/f'), { 'b/f': ENC.encode('data') })
      const outside = join(dir, 'outside')
      await mkdir(outside)
      const staging = join(dir, 'staging')
      await mkdir(staging)
      await symlink(outside, join(staging, 'b'))
      await expect(readFileTar(tar, staging)).rejects.toThrow(/Unsafe blob path/)
      await expect(readFile(join(outside, 'f'))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

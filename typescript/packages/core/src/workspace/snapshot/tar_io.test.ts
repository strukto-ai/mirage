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
import { writeTar, readTar, type TarEntry } from '../../commands/builtin/tar_helper.ts'
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
    const entries = await readTar(tarBytes)
    const mf = entries.find((e) => e.name === 'manifest.json')
    if (mf === undefined) throw new Error('manifest.json not found in tar')
    const parsed = JSON.parse(DEC.decode(mf.data)) as Record<string, unknown>
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
    const entries: TarEntry[] = [
      { name: 'manifest.json', data: ENC.encode(JSON.stringify(manifest)), isFile: true },
    ]
    const tarBytes = await writeTar(entries)
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
    const entries: TarEntry[] = [
      { name: 'manifest.json', data: ENC.encode(JSON.stringify(manifest)), isFile: true },
    ]
    const tarBytes = await writeTar(entries)
    await expect(readSnapshotTar(tarBytes)).rejects.toThrow(/Unsafe blob path/)
  })

  it('throws when manifest.json is missing from the tar', async () => {
    const entries: TarEntry[] = [{ name: 'other.txt', data: ENC.encode('x'), isFile: true }]
    const tarBytes = await writeTar(entries)
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
    // The tar reads a disk file after the state named it; a link put in
    // its place since must not carry a host file into the snapshot.
    const dir = await mkdtemp(join(tmpdir(), 'mirage-tar-'))
    try {
      const secret = join(dir, 'secret')
      await writeFile(secret, 'host')
      const captured = join(dir, 'f')
      await symlink(secret, captured)
      await expect(
        writeFileTar(join(dir, 's.tar'), diskManifest('b/f'), { 'b/f': captured }),
      ).rejects.toThrow()
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

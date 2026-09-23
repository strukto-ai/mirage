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

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { vfsStateRequiresOverride } from '@struktoai/mirage-core/vfs/secrets'
import { MountMode } from '@struktoai/mirage-core/types'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { buildVfs } from './registry.ts'
import { Workspace } from '../workspace.ts'
import { DiskVFS } from './disk/disk.ts'
import { S3VFS } from './s3/s3.ts'
import { GCSVFS } from './gcs/gcs.ts'
import { OCIVFS } from './oci/oci.ts'
import { R2VFS } from './r2/r2.ts'

const ENC = new TextEncoder()

describe('RAM state round-trip', () => {
  it('getState shape includes kind=ram, files, dirs', () => {
    const src = new RAMVFS()
    src.store.files.set('/a.txt', ENC.encode('hello'))
    src.store.dirs.add('/sub')
    const state = src.getState()
    expect(state.type).toBe('ram')
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.files?.['/a.txt']).toBeInstanceOf(Uint8Array)
    expect(state.dirs).toContain('/sub')
  })

  it('round-trips files and dirs through load_state', () => {
    const src = new RAMVFS()
    src.store.files.set('/a.txt', ENC.encode('hello'))
    src.store.files.set('/sub/b.txt', ENC.encode('world'))
    src.store.dirs.add('/sub')
    const state = src.getState()

    const dst = new RAMVFS()
    dst.loadState(state)
    expect(dst.store.files.get('/a.txt')).toEqual(ENC.encode('hello'))
    expect(dst.store.files.get('/sub/b.txt')).toEqual(ENC.encode('world'))
    expect(dst.store.dirs.has('/sub')).toBe(true)
  })
})

describe('Disk state round-trip', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mirage-state-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('getState walks tree and returns files dict', async () => {
    const src = join(root, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'a.txt'), 'hello')
    mkdirSync(join(src, 'sub'))
    writeFileSync(join(src, 'sub', 'b.txt'), 'world')
    const p = new DiskVFS({ root: src })
    const state = await p.getState()
    expect(state.type).toBe('disk')
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.files['a.txt']).toBeInstanceOf(Uint8Array)
    expect(state.files['sub/b.txt']).toBeInstanceOf(Uint8Array)
  })

  it('round-trips files via load_state', async () => {
    const src = join(root, 'src')
    const dst = join(root, 'dst')
    mkdirSync(src)
    mkdirSync(dst)
    writeFileSync(join(src, 'a.txt'), 'hello')
    mkdirSync(join(src, 'sub'))
    writeFileSync(join(src, 'sub', 'b.txt'), 'world')

    const state = await new DiskVFS({ root: src }).getState()
    await new DiskVFS({ root: dst }).loadState(state)

    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('world')
    expect(existsSync(join(dst, 'sub'))).toBe(true)
  })
})

describe('S3 state redaction', () => {
  it('getState redacts accessKeyId / secretAccessKey', async () => {
    const p = new S3VFS({
      bucket: 'my-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA-REAL-KEY-FOR-TEST',
      secretAccessKey: 'REAL-SECRET-KEY-CHARS',
    })
    const state = await p.getState()
    expect(state.type).toBe('s3')
    expect(state.config.bucket).toBe('my-bucket')
    expect(state.config.accessKeyId).toBe('<REDACTED>')
    expect(state.config.secretAccessKey).toBe('<REDACTED>')
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
  })

  it('no real creds leak into state repr', async () => {
    const secret = 'TOPSECRET-VALUE-XYZ'
    const p = new S3VFS({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA-OBVIOUS',
      secretAccessKey: secret,
    })
    const state = await p.getState()
    const blob = JSON.stringify(state)
    expect(blob.includes(secret)).toBe(false)
    expect(blob.includes('AKIA-OBVIOUS')).toBe(false)
    expect(blob.includes('<REDACTED>')).toBe(true)
  })
})

describe('S3-derived backends redact creds (GCS/OCI/R2)', () => {
  const REDACTION_CASES: {
    name: string
    build: () => { getState(): Promise<{ config: unknown }> }
    leaks: string[]
  }[] = [
    {
      name: 'GCSVFS',
      build: () =>
        new GCSVFS({
          bucket: 'b',
          accessKeyId: 'GCS-AKIA-LEAK',
          secretAccessKey: 'GCS-SECRET-LEAK',
        }),
      leaks: ['GCS-AKIA-LEAK', 'GCS-SECRET-LEAK'],
    },
    {
      name: 'OCIVFS',
      build: () =>
        new OCIVFS({
          bucket: 'b',
          namespace: 'ns',
          region: 'us-ashburn-1',
          accessKeyId: 'OCI-AKIA-LEAK',
          secretAccessKey: 'OCI-SECRET-LEAK',
        }),
      leaks: ['OCI-AKIA-LEAK', 'OCI-SECRET-LEAK'],
    },
    {
      name: 'R2VFS',
      build: () =>
        new R2VFS({
          bucket: 'b',
          accountId: 'acc',
          accessKeyId: 'R2-AKIA-LEAK',
          secretAccessKey: 'R2-SECRET-LEAK',
        }),
      leaks: ['R2-AKIA-LEAK', 'R2-SECRET-LEAK'],
    },
  ]

  for (const c of REDACTION_CASES) {
    it(`${c.name}: getState redacts creds and does not leak`, async () => {
      const p = c.build()
      const state = await p.getState()
      expect(state).not.toHaveProperty('needsOverride')
      expect(state).not.toHaveProperty('redactedFields')
      const blob = JSON.stringify(state)
      for (const leaked of c.leaks) {
        expect(blob.includes(leaked)).toBe(false)
      }
      expect(blob.includes('<REDACTED>')).toBe(true)
    })
  }
})

// The audit's ask: derive the table from the registry instead of hand-listing,
// so a backend added later cannot quietly skip the contract. Before this,
// taking a snapshot threw `VFS.getState is not a function` on any
// postgres or mongodb mount — both registry-mountable. BaseVFS's `{type}`
// default now keeps that from throwing, but a config-backed VFS must
// still carry its own: inheriting the bare default leaves no redaction marker,
// so `vfsStateRequiresOverride` returns false and `buildMountArgs`
// substitutes an empty RAMVFS, turning a live database mount into an
// empty directory on load. That is what these cases pin. Twin of
// tests/vfs/test_state_round_trip.py.
describe('every registered VFS answers the state contract', () => {
  // Minimal configs per backend; the registry validates on build, so these
  // only need to be well-formed, not reachable. `secret` is stated outright
  // rather than sniffed: postgres and mongodb bury the password inside a
  // DSN, so no string-shape heuristic finds it.
  const CASES: { name: string; config: Record<string, unknown>; secret: string | null }[] = [
    {
      name: 'postgres',
      config: { dsn: 'postgresql://u:PGSECRET@localhost:5432/db' },
      secret: 'PGSECRET',
    },
    {
      name: 'mongodb',
      config: { uri: 'mongodb://u:MONGOSECRET@localhost:27017/db' },
      secret: 'MONGOSECRET',
    },
    { name: 'lancedb', config: { uri: 'db://x', api_key: 'LANCESECRET' }, secret: 'LANCESECRET' },
    // No credential at all: a local on-disk LanceDB and a keyless Qdrant.
    // Masking the absent key would plant a marker for a snapshot that never
    // held one, which is what Python's redactor avoids by skipping None.
    { name: 'lancedb', config: { uri: 'db://x' }, secret: null },
    { name: 'qdrant', config: { collection: 'c' }, secret: null },
    {
      name: 'qdrant',
      config: { collection: 'c', api_key: 'QDRANTSECRET' },
      secret: 'QDRANTSECRET',
    },
    {
      name: 'dify',
      config: { api_key: 'DIFYSECRET', base_url: 'http://x', dataset_id: 'd' },
      secret: 'DIFYSECRET',
    },
    // chroma reaches its server with no credential at all, so it is the one
    // backend that legitimately needs no override on load.
    { name: 'chroma', config: { collection_name: 'c' }, secret: null },
  ]

  for (const { name, config, secret } of CASES) {
    const what = secret === null ? 'no credential' : 'the credential is masked'
    it(`${name} (${what}): getState/loadState exist, and load demands a VFS`, async () => {
      const vfs = await buildVfs(name, config)
      const state = (await Promise.resolve(vfs.getState())) as {
        type: string
        config?: Record<string, unknown>
      }
      expect(state.type).toBe(name)
      expect(state.config).toBeDefined()

      const blob = JSON.stringify(state)
      if (secret !== null) {
        // The credential must not survive into the snapshot, and the marker
        // it leaves behind is one of the two things that make load demand a
        // fresh one.
        expect(blob.includes(secret)).toBe(false)
        expect(blob.includes('<REDACTED>')).toBe(true)
      } else {
        // Nothing to mask, so nothing is masked. An absent secret must stay
        // absent rather than become `<REDACTED>` — Python's redactor skips
        // None, and a planted marker would claim a credential was dropped.
        expect(blob.includes('<REDACTED>')).toBe(false)
        if ('apiKey' in (state.config ?? {})) expect(state.config?.apiKey).toBeNull()
      }
      // Either way the mount needs a live VFS, because TypeScript
      // rebuilds none of these from state: without this, `buildMountArgs`
      // hands back an empty RAMVFS and a live database mount loads as
      // an empty directory.
      expect(vfsStateRequiresOverride(state)).toBe(true)

      await Promise.resolve(vfs.loadState(state))
      await vfs.close()
    })
  }
})

// The bug this contract closes, end to end. `snapshot/state.ts` cast every
// mount's VFS to `{ getState }` and called it unconditionally, while
// neither postgres nor mongodb implemented one — so taking a snapshot of a
// database mount died with `VFS.getState is not a function`. (Python
// spells the entry point `ws.save()`; TypeScript reaches the same
// `toStateDict` through `copy()` and the snapshot api.)
describe('snapshotting a database mount', () => {
  it('reaches state for a postgres mount instead of throwing', async () => {
    const vfs = await buildVfs('postgres', {
      dsn: 'postgresql://u:PGSECRET@localhost:5432/db',
    })
    const ws = new Workspace({ '/pg': vfs }, { mode: MountMode.READ })
    const state = await toStateDict(ws)

    const mount = state.mounts.find((m) => m.prefix === '/pg/')
    expect(mount).toBeDefined()
    expect(mount?.vfs_class).toBe('postgres')
    // Redacted, so loading this snapshot demands a fresh config rather than
    // quietly substituting an empty RAMVFS for a live database.
    expect(JSON.stringify(state).includes('PGSECRET')).toBe(false)
    expect(vfsStateRequiresOverride(mount?.vfs_state)).toBe(true)
    await ws.close()
  })
})

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
import { RAMResource } from '@struktoai/mirage-core'
import { DiskResource } from './disk/disk.ts'
import { S3Resource } from './s3/s3.ts'
import { GCSResource } from './gcs/gcs.ts'
import { OCIResource } from './oci/oci.ts'
import { R2Resource } from './r2/r2.ts'

const ENC = new TextEncoder()

describe('RAM state round-trip', () => {
  it('getState shape includes kind=ram, files, dirs', () => {
    const src = new RAMResource()
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
    const src = new RAMResource()
    src.store.files.set('/a.txt', ENC.encode('hello'))
    src.store.files.set('/sub/b.txt', ENC.encode('world'))
    src.store.dirs.add('/sub')
    const state = src.getState()

    const dst = new RAMResource()
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
    const p = new DiskResource({ root: src })
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

    const state = await new DiskResource({ root: src }).getState()
    await new DiskResource({ root: dst }).loadState(state)

    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('world')
    expect(existsSync(join(dst, 'sub'))).toBe(true)
  })
})

describe('S3 state redaction', () => {
  it('getState redacts accessKeyId / secretAccessKey', async () => {
    const p = new S3Resource({
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
    const p = new S3Resource({
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
      name: 'GCSResource',
      build: () =>
        new GCSResource({
          bucket: 'b',
          accessKeyId: 'GCS-AKIA-LEAK',
          secretAccessKey: 'GCS-SECRET-LEAK',
        }),
      leaks: ['GCS-AKIA-LEAK', 'GCS-SECRET-LEAK'],
    },
    {
      name: 'OCIResource',
      build: () =>
        new OCIResource({
          bucket: 'b',
          namespace: 'ns',
          region: 'us-ashburn-1',
          accessKeyId: 'OCI-AKIA-LEAK',
          secretAccessKey: 'OCI-SECRET-LEAK',
        }),
      leaks: ['OCI-AKIA-LEAK', 'OCI-SECRET-LEAK'],
    },
    {
      name: 'R2Resource',
      build: () =>
        new R2Resource({
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

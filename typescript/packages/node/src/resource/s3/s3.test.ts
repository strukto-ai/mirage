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

import { PathSpec } from '@struktoai/mirage-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { S3Resource } from './s3.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'

// S3 tests run against an in-memory mock of the AWS SDK v3 S3Client (via
// aws-sdk-client-mock). No external service required.
const bucket = `mirage-s3-test-${String(Date.now())}`
const config: S3Config = {
  bucket,
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  forcePathStyle: true,
}

function mkPath(original: string, prefix = ''): PathSpec {
  return new PathSpec({ original, directory: original, prefix })
}

const DEC = new TextDecoder()
const ENC = new TextEncoder()

// Port of tests/workspace/test_snapshot.py::test_no_real_creds_in_tar_bytes.
// Runs without S3 — pure in-memory check that getState() + snapshot encoding
// never leaks real credentials in the serialized bytes.
describe('S3Resource credential redaction', () => {
  it('getState() redacts accessKeyId/secretAccessKey/sessionToken', async () => {
    const leaky: S3Config = {
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA-OBVIOUS-LEAK',
      secretAccessKey: 'SECRET-OBVIOUS-LEAK',
      sessionToken: 'TOKEN-OBVIOUS-LEAK',
    }
    const res = new S3Resource(leaky)
    const state = await res.getState()
    expect(state.config.accessKeyId).toBe('<REDACTED>')
    expect(state.config.secretAccessKey).toBe('<REDACTED>')
    expect(state.config.sessionToken).toBe('<REDACTED>')
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain('AKIA-OBVIOUS-LEAK')
    expect(serialized).not.toContain('SECRET-OBVIOUS-LEAK')
    expect(serialized).not.toContain('TOKEN-OBVIOUS-LEAK')
    expect(serialized).toContain('<REDACTED>')
  })
})

describe('S3Resource (mocked integration)', () => {
  let resource: S3Resource
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
    resource = new S3Resource(config)
  })

  afterEach(() => {
    // Clear stored objects between tests so writes don't leak.
    for (const b of mock.store.allBuckets()) {
      const objs = mock.store.objects(b)
      objs.clear()
    }
  })

  afterAll(() => {
    mock.restore()
  })

  describe('writes', () => {
    it('writeFile + readFile round-trips', async () => {
      const p = mkPath('/hello.txt')
      await resource.writeFile(p, ENC.encode('hello world'))
      const bytes = await resource.readFile(p)
      expect(DEC.decode(bytes)).toBe('hello world')
    })

    it('appendFile extends existing content', async () => {
      const p = mkPath('/append.txt')
      await resource.writeFile(p, ENC.encode('one\n'))
      await resource.appendFile(p, ENC.encode('two\n'))
      const bytes = await resource.readFile(p)
      expect(DEC.decode(bytes)).toBe('one\ntwo\n')
    })

    it('appendFile on missing key creates the object', async () => {
      const p = mkPath('/append_new.txt')
      await resource.appendFile(p, ENC.encode('fresh'))
      const bytes = await resource.readFile(p)
      expect(DEC.decode(bytes)).toBe('fresh')
    })

    it('copy duplicates the object under a new key', async () => {
      const src = mkPath('/copy_src.txt')
      const dst = mkPath('/copy_dst.txt')
      await resource.writeFile(src, ENC.encode('src data'))
      await resource.copy(src, dst)
      expect(DEC.decode(await resource.readFile(dst))).toBe('src data')
      // Source still there.
      expect(DEC.decode(await resource.readFile(src))).toBe('src data')
    })

    it('rename moves the object', async () => {
      const src = mkPath('/rename_src.txt')
      const dst = mkPath('/rename_dst.txt')
      await resource.writeFile(src, ENC.encode('moving'))
      await resource.rename(src, dst)
      expect(DEC.decode(await resource.readFile(dst))).toBe('moving')
      expect(await resource.exists(src)).toBe(false)
    })

    it('unlink removes a single object', async () => {
      const p = mkPath('/unlink.txt')
      await resource.writeFile(p, ENC.encode('doomed'))
      expect(await resource.exists(p)).toBe(true)
      await resource.unlink(p)
      expect(await resource.exists(p)).toBe(false)
    })

    it('truncate zero-pads to the requested length', async () => {
      const p = mkPath('/truncate.txt')
      await resource.writeFile(p, ENC.encode('abcdef'))
      await resource.truncate(p, 3)
      expect(DEC.decode(await resource.readFile(p))).toBe('abc')
      await resource.truncate(p, 5)
      const bytes = await resource.readFile(p)
      expect(bytes.byteLength).toBe(5)
      expect(DEC.decode(bytes.subarray(0, 3))).toBe('abc')
      expect(bytes[3]).toBe(0)
      expect(bytes[4]).toBe(0)
    })
  })

  describe('reads', () => {
    it('readdir returns full paths for immediate children', async () => {
      await resource.writeFile(mkPath('/rd/a.txt'), ENC.encode('a'))
      await resource.writeFile(mkPath('/rd/b.txt'), ENC.encode('b'))
      await resource.writeFile(mkPath('/rd/sub/c.txt'), ENC.encode('c'))
      const entries = await resource.readdir(mkPath('/rd/'))
      expect(entries.sort()).toEqual(['/rd/a.txt', '/rd/b.txt', '/rd/sub'])
    })

    it('stat returns size + ETag fingerprint', async () => {
      const p = mkPath('/stat.txt')
      await resource.writeFile(p, ENC.encode('sized'))
      const s = await resource.stat(p)
      expect(s.size).toBe(5)
      expect(typeof s.fingerprint).toBe('string')
      expect((s.fingerprint ?? '').length).toBeGreaterThan(0)
    })

    it('stat treats a trailing-slash path as a directory probe', async () => {
      // Some S3-compatible backends (notably MinIO) don't allow a file at
      // `hint` and a prefix `hint/...` to coexist — the second write silently
      // overwrites the namespace. Real AWS S3 does allow it. For portability
      // we exercise only the directory-probe branch here; the file branch is
      // covered by the other stat tests.
      await resource.writeFile(mkPath('/hintdir/child'), ENC.encode('inside'))
      const dirStat = await resource.stat(mkPath('/hintdir/'))
      expect(dirStat.type).toBe('directory')
    })

    it('exists returns false for missing keys', async () => {
      expect(await resource.exists(mkPath('/does/not/exist.txt'))).toBe(false)
    })

    it('fingerprint matches ETag from stat', async () => {
      const p = mkPath('/fp.txt')
      await resource.writeFile(p, ENC.encode('fingerprint me'))
      const fp = await resource.fingerprint(p)
      const s = await resource.stat(p)
      expect(fp).toBe(s.fingerprint)
    })
  })

  describe('recursive', () => {
    it('du sums sizes under a prefix', async () => {
      await resource.writeFile(mkPath('/du/a'), ENC.encode('x'.repeat(10)))
      await resource.writeFile(mkPath('/du/b'), ENC.encode('y'.repeat(20)))
      const total = await resource.du(mkPath('/du/'))
      expect(total).toBe(30)
    })

    it('rmR deletes every object under the prefix', async () => {
      await resource.writeFile(mkPath('/rmr/x.txt'), ENC.encode('x'))
      await resource.writeFile(mkPath('/rmr/sub/y.txt'), ENC.encode('y'))
      await resource.rmR(mkPath('/rmr/'))
      expect(await resource.exists(mkPath('/rmr/x.txt'))).toBe(false)
      expect(await resource.exists(mkPath('/rmr/sub/y.txt'))).toBe(false)
    })

    it('find with name glob matches expected entries', async () => {
      await resource.writeFile(mkPath('/find/a.txt'), ENC.encode('a'))
      await resource.writeFile(mkPath('/find/b.md'), ENC.encode('b'))
      await resource.writeFile(mkPath('/find/c.txt'), ENC.encode('c'))
      const txts = await resource.find(mkPath('/find/'), { name: '*.txt' })
      expect(txts.sort()).toEqual(['/find/a.txt', '/find/c.txt'])
    })

    it('find with minSize skips small files, letting directories pass', async () => {
      await resource.writeFile(mkPath('/sz/small'), ENC.encode('x'))
      await resource.writeFile(mkPath('/sz/big'), ENC.encode('x'.repeat(100)))
      const results = await resource.find(mkPath('/sz/'), { minSize: 10 })
      expect(results).toEqual(['/sz', '/sz/big'])
    })
  })
})

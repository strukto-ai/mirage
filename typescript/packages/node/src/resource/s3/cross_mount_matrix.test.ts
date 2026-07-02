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

import { stripSlash } from '@struktoai/mirage-core'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { MountMode, RAMResource, type Resource } from '@struktoai/mirage-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { DiskResource } from '../disk/disk.ts'
import { S3Resource } from './s3.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'

type BackendKind = 'ram' | 'disk' | 's3'

const WRITABLE: ReadonlySet<BackendKind> = new Set(['ram', 'disk', 's3'])
const PAIRS: readonly (readonly [BackendKind, BackendKind])[] = [
  ['ram', 's3'],
  ['s3', 'ram'],
  ['disk', 's3'],
  ['s3', 'disk'],
  ['s3', 's3'],
]

function s3Config(bucket: string): S3Config {
  return {
    bucket,
    region: 'us-east-1',
    accessKeyId: 'testing',
    secretAccessKey: 'testing',
    forcePathStyle: true,
  }
}

interface MountState {
  kind: BackendKind
  resource: Resource
  diskRoot: string | null
  s3Bucket: string | null
}

function buildMount(kind: BackendKind, tmpRoot: string, idx: number): MountState {
  if (kind === 'ram') {
    return { kind, resource: new RAMResource(), diskRoot: null, s3Bucket: null }
  }
  if (kind === 'disk') {
    const root = path.join(tmpRoot, `disk${idx.toString()}`)
    mkdirSync(root, { recursive: true })
    return { kind, resource: new DiskResource({ root }), diskRoot: root, s3Bucket: null }
  }
  const bucket = `test-bucket-${idx.toString()}`
  return { kind, resource: new S3Resource(s3Config(bucket)), diskRoot: null, s3Bucket: bucket }
}

async function populate(
  state: MountState,
  name: string,
  content: Uint8Array,
  mock: S3Mock,
): Promise<void> {
  if (state.kind === 's3') {
    if (state.s3Bucket === null) throw new Error('s3 mount missing bucket')
    mock.store.set(state.s3Bucket, name, content)
    return
  }
  const { PathSpec } = await import('@struktoai/mirage-core')
  const fullPath = `/${name}`
  const r = state.resource as RAMResource | DiskResource
  const parts = name.split('/').filter(Boolean)
  if (parts.length > 1) {
    const dir = `/${parts.slice(0, -1).join('/')}`
    try {
      await r.mkdir(new PathSpec({ resourcePath: stripSlash(dir), virtual: dir, directory: dir }), {
        recursive: true,
      })
    } catch {
      // ignore existing dirs
    }
  }
  await r.writeFile(
    new PathSpec({ resourcePath: stripSlash(fullPath), virtual: fullPath, directory: fullPath }),
    content,
  )
}

interface CrossEnv {
  ws: Workspace
  m1: MountState
  m2: MountState
}

async function runCmd(env: CrossEnv, cmd: string): Promise<string> {
  const io = await env.ws.execute(cmd)
  return new TextDecoder().decode(io.stdout)
}

async function runExit(env: CrossEnv, cmd: string): Promise<number> {
  const io = await env.ws.execute(cmd)
  return io.exitCode
}

const ENC = new TextEncoder()

for (const [src, dst] of PAIRS) {
  const pairId = `${src}->${dst}`
  describe(`cross-mount ${pairId}`, () => {
    let mock: S3Mock
    let tmpRoot: string
    let env: CrossEnv

    beforeAll(() => {
      mock = installS3Mock()
    })

    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mirage-xmount-'))
      const m1 = buildMount(src, tmpRoot, 1)
      const m2 = buildMount(dst, tmpRoot, 2)
      const ws = new Workspace(
        {
          '/m1': m1.resource,
          '/m2': m2.resource,
        },
        { mode: MountMode.WRITE },
      )
      ws.cwd = '/m1'
      env = { ws, m1, m2 }
    })

    afterEach(async () => {
      await env.ws.close()
      for (const b of mock.store.allBuckets()) {
        mock.store.objects(b).clear()
      }
      rmSync(tmpRoot, { recursive: true, force: true })
    })

    afterAll(() => {
      mock.restore()
    })

    it('cat cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('aaa\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('bbb\n'), mock)
      const out = await runCmd(env, 'cat /m1/a.txt /m2/b.txt')
      expect(out).toContain('aaa')
      expect(out).toContain('bbb')
    })

    it('grep cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('hello world\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('hello there\n'), mock)
      const out = await runCmd(env, 'grep hello /m1/a.txt /m2/b.txt')
      expect(out).toContain('/m1/a.txt:')
      expect(out).toContain('/m2/b.txt:')
    })

    it('head cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('a1\na2\na3\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('b1\nb2\nb3\n'), mock)
      const out = await runCmd(env, 'head -n 1 /m1/a.txt /m2/b.txt')
      expect(out).toContain('==> /m1/a.txt <==')
      expect(out).toContain('==> /m2/b.txt <==')
    })

    it('wc cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('line1\nline2\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('only\n'), mock)
      const out = await runCmd(env, 'wc -l /m1/a.txt /m2/b.txt')
      expect(out).toContain('/m1/a.txt')
      expect(out).toContain('/m2/b.txt')
    })

    it('diff identical cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('same\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('same\n'), mock)
      const out = await runCmd(env, 'diff /m1/a.txt /m2/b.txt')
      expect(out).toBe('')
    })

    it('diff different cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('hello\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('world\n'), mock)
      const out = await runCmd(env, 'diff /m1/a.txt /m2/b.txt')
      expect(out.includes('hello') || out.includes('world')).toBe(true)
    })

    it('cmp identical cross', async () => {
      await populate(env.m1, 'a.txt', ENC.encode('same\n'), mock)
      await populate(env.m2, 'b.txt', ENC.encode('same\n'), mock)
      const code = await runExit(env, 'cmp /m1/a.txt /m2/b.txt')
      expect(code).toBe(0)
    })

    it('cp cross', async () => {
      await populate(env.m1, 'src.txt', ENC.encode('hello\n'), mock)
      const code = await runExit(env, 'cp /m1/src.txt /m2/dst.txt')
      if (WRITABLE.has(env.m2.kind)) {
        expect(code).toBe(0)
        expect(await runCmd(env, 'cat /m2/dst.txt')).toBe('hello\n')
      } else {
        expect(code).not.toBe(0)
      }
    })

    it('mv cross', async () => {
      await populate(env.m1, 'src.txt', ENC.encode('hello\n'), mock)
      const code = await runExit(env, 'mv /m1/src.txt /m2/moved.txt')
      if (WRITABLE.has(env.m2.kind) && WRITABLE.has(env.m1.kind)) {
        expect(code).toBe(0)
        expect(await runCmd(env, 'cat /m2/moved.txt')).toBe('hello\n')
        expect(await runExit(env, 'cat /m1/src.txt')).not.toBe(0)
      } else {
        expect(code).not.toBe(0)
      }
    })
  })
}

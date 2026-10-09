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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import { MountMode } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import type { SSHAccessor } from '../accessor/ssh.ts'
import { type FakeSftp, makeFakeAccessor } from '../core/ssh/_test_utils.ts'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { installS3Mock } from '../vfs/s3/mock.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { SSHVFS } from '../vfs/ssh/ssh.ts'
import { Workspace } from '../workspace.ts'

// Every record a backend makes must name the operand's virtual path. The key
// is named like its mount (`m/k.txt` under `/m`), so a mount-relative
// `/m/k.txt` is not its virtual path. The op sequences are measured per
// backend; every path is the operand's virtual path, never a measured value.

const SCRIPT = [
  'echo x > /m/m/k.txt',
  'echo y >> /m/m/k.txt',
  'echo z | tee -a /m/m/k.txt',
  'touch /m/m/new.txt',
  'truncate -s 0 /m/m/new.txt',
  'cat /m/m/k.txt',
  'cp /m/m/k.txt /r/k.txt',
  'cp /m/m/k.txt /m/m/k2.txt',
  'mv /m/m/new.txt /m/m/moved.txt',
  'rm /m/m/moved.txt',
  'mkdir /m/m/e; rmdir /m/m/e',
  'mkdir /m/m/d; touch /m/m/d/f; rm -r /m/m/d',
  'gzip -k /m/m/k.txt',
  'gunzip -k -f /m/m/k.txt.gz',
  'split -l 1 /m/m/k.txt /m/m/x',
  'csplit -f /m/m/cs /m/m/k.txt 2',
]

// Namespace ops record against the enclosing frame, not the backend.
const EXEMPT = new Set([
  'setattr',
  'symlink',
  'readlink',
  'getxattr',
  'setxattr',
  'listxattr',
  'removexattr',
])

const K = '/m/m/k.txt'
const NEW = '/m/m/new.txt'
const C = '/m/m/c.txt'
const GZ = '/m/m/k.txt.gz'

// gzip, gunzip, split and csplit build their output spec from the operand's
// key; each output must still be recorded under its virtual path.
const GENERIC_OUT: [string, string][] = [
  ['read', K],
  ['write', GZ],
  ['read', GZ],
  ['write', K],
  ['read', K],
  ['write', '/m/m/xaa'],
  ['write', '/m/m/xab'],
  ['write', '/m/m/xac'],
  ['read', K],
  ['write', '/m/m/cs00'],
  ['write', '/m/m/cs01'],
]

function underM(records: readonly OpRecord[]): [string, string][] {
  return records
    .filter((r) => (r.path === '/m' || r.path.startsWith('/m/')) && !EXEMPT.has(r.op))
    .map((r) => [r.op, r.path])
}

async function ledger(vfs: BaseVFS, setup: string | null): Promise<[string, string][]> {
  const ws = new Workspace({ '/m': vfs, '/r': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    if (setup !== null) expect((await ws.shell(setup)).exitCode).toBe(0)
    const start = ws.records.length
    for (const line of SCRIPT) {
      const io = await ws.shell(line)
      expect(io.exitCode, `${line}: ${new TextDecoder().decode(io.stderr)}`).toBe(0)
    }
    const shell = ws.records.slice(start)
    const [, block] = await runWithRecording(async () => {
      await ws.dispatch('create', C)
      await ws.dispatch('append', C, [new TextEncoder().encode('q')])
    })
    return underM([...shell, ...block])
  } finally {
    await ws.close()
  }
}

// Redirects open before echo runs: `>` records its empty open and output
// write. RAM skips recording an empty append; disk and SSH record it.
const NATIVE_APPEND: [string, string][] = [
  ['write', K],
  ['write', K],
  ['append', K],
  ['append', K],
  ['write', NEW],
  ['truncate', NEW],
  ['read', K],
  ['read', K],
  ['write', '/m/m/d/f'],
  ...GENERIC_OUT,
]

describe('record paths name the virtual path (node backends)', () => {
  it('ram', async () => {
    expect(await ledger(new RAMVFS(), 'mkdir -p /m/m')).toEqual([
      ...NATIVE_APPEND,
      ['create', C],
      ['append', C],
    ])
  })

  it('disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-record-paths-'))
    mkdirSync(join(root, 'm'))
    try {
      expect(await ledger(new DiskVFS({ root }), null)).toEqual([
        ...NATIVE_APPEND.slice(0, 2),
        ['append', K],
        ...NATIVE_APPEND.slice(2),
        ['create', C],
        ['append', C],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('s3', async () => {
    const mock = installS3Mock()
    try {
      const vfs = new S3VFS({
        bucket: 'record-paths',
        region: 'us-east-1',
        accessKeyId: 'fake',
        secretAccessKey: 'fake',
        forcePathStyle: true,
      })
      // cat and the cp sources are served from cache; tee -a and the op-door
      // append are a read plus a write, since s3 has no native append.
      expect(await ledger(vfs, null)).toEqual([
        ['write', K],
        ['write', K],
        ['read', K],
        ['write', K],
        ['read', K],
        ['write', K],
        ['write', NEW],
        ['truncate', NEW],
        ['copy', '/m/m/k2.txt'],
        ['rename', NEW],
        ['rename', '/m/m/moved.txt'],
        ['unlink', '/m/m/moved.txt'],
        ['rmdir', '/m/m/e'],
        ['write', '/m/m/d/f'],
        ['rm_r', '/m/m/d'],
        ...GENERIC_OUT,
        ['create', C],
        ['read', C],
        ['write', C],
      ])
    } finally {
      mock.restore()
    }
  })

  it('ssh', async () => {
    const state: FakeSftp = {
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/m', {}],
      ]),
    }
    const vfs = new SSHVFS({ host: 'example.com', username: 'alice', password: 'secret' })
    ;(vfs as { accessor: SSHAccessor }).accessor = makeFakeAccessor(state, '/')
    // ssh caches reads, so only cat's read of k.txt reaches the server; the
    // later reads, the in-mount cp's included, are served from the cache.
    expect(await ledger(vfs, null)).toEqual([
      ['write', K],
      ['write', K],
      ['append', K],
      ['append', K],
      ['append', K],
      ['write', NEW],
      ['truncate', NEW],
      ['read', K],
      ['write', '/m/m/k2.txt'],
      ['write', '/m/m/d/f'],
      ...GENERIC_OUT.filter(([op]) => op === 'write'),
      ['create', C],
      ['append', C],
    ])
  })
})

// SCRIPT plus reads and writes of a mount-root key, and a stdin split and
// csplit, which have no operand to name their outputs from. A record made
// with the mount-relative key `/k2.txt` resolves to `/`, not `/m`, so every
// record must resolve to the mount whose id it carries.
const SWEEP = [
  ...SCRIPT,
  'head -c 1 /m/k2.txt',
  'grep x /m/k2.txt',
  'wc -c /m/k2.txt',
  'tail -c 1 /m/k2.txt',
  'ls /m/m',
  'cat /m/k2.txt',
  'echo y >> /m/k2.txt',
  'echo z | tee -a /m/k2.txt',
  'truncate -s 1 /m/k2.txt',
  'touch /m/k3.txt',
  'gzip -k /m/k2.txt',
  "cd /m && printf 'a\\nb\\n' | split -l 1",
  "cd /m && printf 'a\\nb\\n' | csplit - 2",
]

interface Swept {
  records: OpRecord[]
  catRecords: OpRecord[]
  resolve: (path: string) => string
  mountId: string
}

async function sweep(vfs: BaseVFS, setup: string | null): Promise<Swept> {
  const ws = new Workspace({ '/m': vfs, '/r': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    if (setup !== null) expect((await ws.shell(setup)).exitCode).toBe(0)
    expect((await ws.shell('echo x > /m/k2.txt')).exitCode).toBe(0)
    const start = ws.records.length
    let catRecords: OpRecord[] = []
    for (const line of SWEEP) {
      const before = ws.records.length
      const io = await ws.shell(line)
      expect(io.exitCode, `${line}: ${new TextDecoder().decode(io.stderr)}`).toBe(0)
      if (line === `cat ${K}`) catRecords = ws.records.slice(before)
    }
    const shell = ws.records.slice(start)
    const [, block] = await runWithRecording(async () => {
      await ws.dispatch('create', C)
      await ws.dispatch('append', C, [new TextEncoder().encode('q')])
    })
    const ids = new Map<string, string>()
    for (const r of [...shell, ...block]) ids.set(r.path, ws.registry.mountFor(r.path).mountId)
    return {
      records: [...shell, ...block],
      catRecords,
      resolve: (path) => ids.get(path) ?? '',
      mountId: ws.mount('/m').mountId,
    }
  } finally {
    await ws.close()
  }
}

function expectResolvable(swept: Swept): void {
  const checked = swept.records.filter((r) => r.mountId !== null && !EXEMPT.has(r.op))
  expect(checked.length).toBeGreaterThan(0)
  for (const r of checked) {
    expect(swept.resolve(r.path), `${r.op} ${r.path}`).toBe(r.mountId)
  }
}

function makeS3(): S3VFS {
  return new S3VFS({
    bucket: 'record-paths',
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  })
}

function makeSsh(): SSHVFS {
  const state: FakeSftp = {
    files: new Map(),
    dirs: new Map([
      ['/', {}],
      ['/m', {}],
    ]),
  }
  const vfs = new SSHVFS({ host: 'example.com', username: 'alice', password: 'secret' })
  ;(vfs as { accessor: SSHAccessor }).accessor = makeFakeAccessor(state, '/')
  return vfs
}

describe('every record resolves to the mount whose id it carries (node backends)', () => {
  it('ram', async () => {
    expectResolvable(await sweep(new RAMVFS(), 'mkdir -p /m/m'))
  })

  it('disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-record-paths-'))
    mkdirSync(join(root, 'm'))
    try {
      expectResolvable(await sweep(new DiskVFS({ root }), null))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('s3', async () => {
    const mock = installS3Mock()
    try {
      expectResolvable(await sweep(makeS3(), null))
    } finally {
      mock.restore()
    }
  })

  it('ssh', async () => {
    expectResolvable(await sweep(makeSsh(), null))
  })
})

// The command door wraps a lazily consumed stream so its deferred backend
// read records under the mount that produced it (`wrapMountStreams`).
describe('command-door streams carry the mount id', () => {
  it('ram cat', async () => {
    const swept = await sweep(new RAMVFS(), 'mkdir -p /m/m')
    expect(swept.catRecords.map((r) => [r.op, r.path])).toEqual([['read', K]])
    expect(swept.catRecords[0]?.mountId).toBe(swept.mountId)
  })

  it('disk cat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-record-paths-'))
    mkdirSync(join(root, 'm'))
    try {
      const swept = await sweep(new DiskVFS({ root }), null)
      expect(swept.catRecords.map((r) => [r.op, r.path])).toEqual([['read', K]])
      expect(swept.catRecords[0]?.mountId).toBe(swept.mountId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The dispatch door (redirects, cp, a direct `ws.dispatch`) binds the
// executing mount's id too, so no record of the sweep is left unattributed.
describe('dispatch-door records carry the mount id', () => {
  it('ram', async () => {
    const swept = await sweep(new RAMVFS(), 'mkdir -p /m/m')
    const unattributed = swept.records
      .filter((r) => r.mountId === null && !EXEMPT.has(r.op))
      .map((r) => [r.op, r.path])
    expect(unattributed).toEqual([])
    expect(swept.records.some((r) => r.op === 'create' && r.mountId === swept.mountId)).toBe(true)
  })
})

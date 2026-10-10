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

import { describe, expect, it } from 'vitest'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import { MountMode } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { createFakeUpstash, installFakeNavigator, makeMockRoot } from './test-utils.ts'
import { OPFSVFS } from './vfs/opfs/opfs.ts'
import { RedisVFS } from './vfs/redis/redis.ts'
import { Workspace } from './workspace.ts'

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

// An echo `>` redirect opens its target with its output, one write; `>>`
// opens before echo runs, and on an existing file records no data write.
const SHELL_LEDGER: [string, string][] = [
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

function underM(records: readonly OpRecord[]): [string, string][] {
  return records
    .filter((r) => (r.path === '/m' || r.path.startsWith('/m/')) && !EXEMPT.has(r.op))
    .map((r) => [r.op, r.path])
}

async function ledger(vfs: BaseVFS): Promise<[string, string][]> {
  const ws = new Workspace({ '/m': vfs, '/r': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    expect((await ws.shell('mkdir -p /m/m')).exitCode).toBe(0)
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

describe('record paths name the virtual path (browser backends)', () => {
  it('opfs', async () => {
    const restore = installFakeNavigator(() => makeMockRoot())
    try {
      // opfs create records `write`.
      expect(await ledger(new OPFSVFS())).toEqual([...SHELL_LEDGER, ['write', C], ['append', C]])
    } finally {
      restore()
    }
  })

  it('redis', async () => {
    const fake = createFakeUpstash()
    const vfs = new RedisVFS({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: fake.fetch,
    })
    expect(await ledger(vfs)).toEqual([...SHELL_LEDGER, ['create', C], ['append', C]])
  })
})

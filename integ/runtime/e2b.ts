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

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Workspace, SSHResource, SSHRuntime } from '@struktoai/mirage-node'
import { Limit, MountMode, RAMResource } from '@struktoai/mirage-core'
import { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'
import { exerciseCancellation } from '../fixtures/runtime/e2b_cancel.ts'

const dec = new TextDecoder()
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function exercise(runtime: E2BRuntime | SSHRuntime, label: string) {
  const bytes = Uint8Array.from({ length: 262144 }, (_, i) => i % 256)
  for (const data of [null, new Uint8Array(), bytes]) {
    const result = await runtime.runLine(
      "python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'",
      data,
      {},
      '/home/user',
    )
    assert.equal(result.exitCode, 0)
    assert.equal(dec.decode(result.stdout).trim(), hash(data ?? new Uint8Array()))
  }
  for (let i = 0; i < 6; i++) {
    const result = await runtime.runLine(
      'printf out; printf err >&2; exit 7',
      new Uint8Array([1]),
      {},
      '/home/user',
    )
    assert.equal(result.exitCode, 7)
    assert.equal(dec.decode(result.stdout), 'out')
    assert.equal(dec.decode(result.stderr ?? undefined), 'err')
  }
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      runtime.runLine(
        "python3 -c 'import sys,time,json; s=time.time(); d=sys.stdin.buffer.read(); time.sleep(2); print(json.dumps([s,time.time(),d.hex()]))'",
        new Uint8Array([i]),
        {},
        '/home/user',
      ),
    ),
  )
  const parsed = results.map((r) => JSON.parse(dec.decode(r.stdout)) as [number, number, string])
  assert.deepEqual(
    parsed.map((p) => p[2]),
    Array.from({ length: 6 }, (_, i) => Buffer.from([i]).toString('hex')),
  )
  assert.ok(Math.max(...parsed.map((p) => p[0])) < Math.min(...parsed.map((p) => p[1])))
  console.log(JSON.stringify({ check: label + '_stdin_eof_exit_parallel' }))
}

const e2b = new E2BRuntime({ config: { sandboxId: process.env.E2B_SANDBOX_ID! } })
const sshConfig = {
  host: '127.0.0.1',
  port: Number(process.env.E2B_SSH_PORT),
  username: 'user',
  identityFile: process.env.E2B_SSH_IDENTITY!,
}
const ssh = new SSHRuntime({ captures: ['python3'], config: sshConfig })
try {
  await exercise(e2b, 'typescript_e2b')
  const cancelWorkspace = new Workspace(
    { '/home/user': new RAMResource() },
    {
      mode: MountMode.EXEC,
      runtimes: [e2b, 'vfs'],
      commandLimits: { '/home/user': { exec: new Limit({ timeoutSeconds: 5 }) } },
    },
  )
  try {
    await exerciseCancellation(e2b, cancelWorkspace)
    console.log(JSON.stringify({ check: 'typescript_e2b_caller_and_timeout_kill_pid' }))
  } finally {
    await cancelWorkspace.close()
  }
  await exercise(ssh, 'typescript_ssh')
  const ws = new Workspace(
    { '/home/user/work': new SSHResource({ ...sshConfig, root: '/home/user/work' }) },
    { mode: MountMode.EXEC, runtimes: [ssh, 'vfs'] },
  )
  try {
    let result = await ws.execute('cat > /home/user/work/ts-output.txt', {
      stdin: new TextEncoder().encode('old'),
    })
    assert.equal(result.exitCode, 0)
    result = await ws.execute('cat /home/user/work/ts-output.txt')
    assert.equal(result.stdoutText, 'old')
    result = await ws.execute(
      'python3 -c \'from pathlib import Path; Path("/home/user/work/ts-output.txt").write_text("from typescript ssh")\'',
      { cwd: '/home/user/work' },
    )
    assert.equal(result.exitCode, 0, result.stderrText)
    result = await ws.execute('cat /home/user/work/ts-output.txt')
    assert.equal(result.stdoutText, 'from typescript ssh')
    console.log(JSON.stringify({ check: 'typescript_router_shared_sftp_cache_invalidation' }))
  } finally {
    await ws.close()
  }
} finally {
  await ssh.close()
  await e2b.close()
}

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

import { Limit, MountMode, RAMResource, Workspace } from '@struktoai/mirage-browser'
import { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'

import { exerciseCancellation } from './e2b_cancel.ts'

const dec = new TextDecoder()

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export async function exercise(config: { sandboxId: string; apiKey: string }): Promise<string[]> {
  const runtime = new E2BRuntime({ captures: ['python3', 'node'], config })
  const checks: string[] = []
  try {
    // Concurrent first calls also exercise the shared connection latch.
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
    const parsed = results.map((result, i) => {
      check(result.exitCode === 0, dec.decode(result.stderr ?? undefined))
      const row = JSON.parse(dec.decode(result.stdout)) as [number, number, string]
      check(row[2] === i.toString(16).padStart(2, '0'), 'parallel stdin crossed commands')
      return row
    })
    check(
      Math.max(...parsed.map((p) => p[0])) < Math.min(...parsed.map((p) => p[1])),
      'commands did not overlap',
    )
    checks.push('six concurrent first commands')

    const bytes = Uint8Array.from({ length: 262144 }, (_, i) => i % 256)
    for (const stdin of [null, new Uint8Array(), bytes]) {
      const digest = await crypto.subtle.digest('SHA-256', stdin ?? new Uint8Array())
      const expected = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      const result = await runtime.runLine(
        "python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'",
        stdin,
        {},
        '/home/user',
      )
      check(result.exitCode === 0, dec.decode(result.stderr ?? undefined))
      check(dec.decode(result.stdout).trim() === expected, 'stdin bytes or EOF changed')
    }
    checks.push('absent, empty, and 256 KiB binary stdin with EOF')

    for (let i = 0; i < 6; i++) {
      const result = await runtime.runLine(
        'printf out; printf err >&2; exit 7',
        new Uint8Array([1]),
        {},
        '/home/user',
      )
      check(result.exitCode === 7, 'lost nonzero exit status')
      check(
        dec.decode(result.stdout) === 'out' && dec.decode(result.stderr ?? undefined) === 'err',
        'lost command output',
      )
    }
    checks.push('stdout, stderr, and early nonzero exit')

    const workspace = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        runtimes: [runtime, 'vfs'],
      },
    )
    try {
      const result = await workspace.execute(
        `printf 'from browser' | python3 -c 'import os,sys; print(os.environ["BROWSER_CHECK"] + ":" + sys.stdin.read().upper())'`,
        { cwd: '/home/user', env: { BROWSER_CHECK: 'native' } },
      )
      check(result.exitCode === 0, result.stderrText)
      check(result.stdoutText === 'native:FROM BROWSER\n', 'VFS to E2B pipeline failed')
      const local = await workspace.execute('echo still-vfs')
      check(local.exitCode === 0 && local.stdoutText === 'still-vfs\n', 'VFS fallback failed')
      const node = await workspace.execute(`node -e 'console.log(process.cwd())'`, {
        cwd: '/home/user',
      })
      check(
        node.exitCode === 0 && node.stdoutText.trim() === '/home/user',
        'Node routing or cwd failed',
      )
      checks.push('browser workspace routing, pipe, env, cwd, and VFS fallback')
    } finally {
      await workspace.close()
    }
  } finally {
    await runtime.close()
  }
  const cancellable = new E2BRuntime({ config })
  const cancelWorkspace = new Workspace(
    { '/home/user': new RAMResource() },
    {
      mode: MountMode.EXEC,
      runtimes: [cancellable, 'vfs'],
      commandLimits: { '/home/user': { exec: new Limit({ timeoutSeconds: 5 }) } },
    },
  )
  try {
    await exerciseCancellation(cancellable, cancelWorkspace)
    checks.push(
      'caller cancellation and workspace timeout stop the PID and preserve concurrent commands',
    )
  } finally {
    await cancelWorkspace.close()
  }
  return checks
}

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
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { MicrosandboxRuntime, MountMode, PathSpec, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'

const sandbox = process.env.MIRAGE_E2E_SANDBOX!
assert.ok(sandbox, 'set MIRAGE_E2E_SANDBOX')
const guest = '/e2e-guest'
const host = '/e2e host \u2603'
const dec = new TextDecoder()
const enc = new TextEncoder()
const passed: string[] = []
const failed: string[] = []
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const payload = Uint8Array.from({ length: 4194304 }, (_, i) => i % 256)

async function check(name: string, operation: () => Promise<unknown>) {
  try {
    await operation()
    passed.push(name)
    console.log(JSON.stringify({ check: name, status: 'PASS' }))
  } catch (error) {
    failed.push(name)
    console.log(JSON.stringify({ check: name, status: 'FAIL', error: String(error) }))
  }
}

async function raw(command: string) {
  return new MicrosandboxRuntime({ config: { sandbox } }).execLine(command, null, {}, '/')
}

async function transport() {
  const runtime = new MicrosandboxRuntime({ config: { sandbox } })
  for (const data of [null, new Uint8Array(), new Uint8Array([0, 255, 13, 10]), payload]) {
    const result = await runtime.execute(
      [],
      [
        'python3',
        '-c',
        'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())',
      ],
      { flags: {}, cwd: PathSpec.fromStrPath('/tmp'), stdin: data, env: {} },
      { kind: 'process' },
    )
    assert.equal(result.exitCode, 0, dec.decode(result.stderr ?? undefined))
    assert.equal(dec.decode(result.stdout).trim(), hash(data ?? new Uint8Array()))
    assert.equal(dec.decode(result.stderr ?? undefined), '')
  }
  const words = ['a b', '$(literal)', '', '--flag', '\u2603', 'one\ntwo']
  const marker = 'quotes \' " $ and\nnewlines'
  const result = await runtime.execute(
    [],
    [
      'python3',
      '-c',
      "import os,sys,json; assert os.getcwd()=='/tmp'; " +
        "assert os.environ['MARK']==sys.argv[1]; sys.stdout.buffer.write(sys.stdin.buffer.read()); " +
        'sys.stderr.write(json.dumps(sys.argv[2:])); sys.exit(23)',
      marker,
      ...words,
    ],
    { flags: {}, cwd: PathSpec.fromStrPath('/tmp'), env: { MARK: marker }, stdin: payload },
    { kind: 'process' },
  )
  assert.deepEqual(Buffer.from(result.stdout), Buffer.from(payload))
  assert.deepEqual(JSON.parse(dec.decode(result.stderr ?? undefined)), words)
  assert.equal(result.exitCode, 23)
  const large = await runtime.execLine(
    `python3 -c 'import sys; sys.stdout.write("O"*2097152); sys.stderr.write("E"*1048576)'`,
    null,
    {},
    '/tmp',
  )
  assert.equal(large.exitCode, 0)
  assert.equal(dec.decode(large.stdout), 'O'.repeat(2097152))
  assert.equal(dec.decode(large.stderr ?? undefined), 'E'.repeat(1048576))
  await runtime.close()
}

async function modeChecks(mountType: 'ssh' | 'fuse' | 'both') {
  const prefix = mountType === 'fuse' ? guest : host
  const source = new RAMVFS()
  const readonly = new RAMVFS()
  await source.write(
    PathSpec.fromStrPath('/seed.txt'),
    enc.encode(mountType === 'fuse' ? 'host-only\n' : 'seed\n'),
  )
  await source.write(PathSpec.fromStrPath('/secret.txt'), enc.encode('host secret\n'))
  await readonly.write(PathSpec.fromStrPath('/protected.txt'), enc.encode('locked\n'))
  const mounts: Record<string, RAMVFS | [RAMVFS, MountMode]> = {
    [prefix]: source,
    [prefix + '/ro']: [readonly, MountMode.READ],
  }
  if (mountType === 'both') mounts[guest] = new RAMVFS()
  const runtime = new MicrosandboxRuntime({
    captures: ['python3', 'dash', 'sleep'],
    config: { sandbox, mountType },
  })
  const ws = new Workspace(mounts, {
    mode: MountMode.EXEC,
    runtimes: [runtime, 'workspace'],
    profiles: { hidden: { paths: { hide: [prefix + '/secret.txt'] } } },
  })
  const agent = await ws.session('agent', mountType === 'fuse' ? {} : { profile: 'hidden' })

  async function probe(operation: string, extra = '') {
    const result = await agent.shell(
      `python3 /tmp/mirage_e2e_ops.py ${singleQuote(prefix)} ${operation}${extra}`,
      { cwd: prefix },
    )
    assert.equal(result.exitCode, 0, dec.decode(result.stderr))
    return JSON.parse(dec.decode(result.stdout)) as Record<string, string | number>
  }
  try {
    await check(mountType + '_mounted_cwd_literal_argv_env_stdin_invalid_cwd', async () => {
      await probe('seed')
      const words = ['a b', '$(literal)', '', '--flag', '☃', 'one\ntwo']
      const marker = 'quotes \' " $ and\nnewlines'
      const input = new Uint8Array([0, 255, 13, 10])
      const argv = [
        'python3',
        '-c',
        'import os,sys,json; ' +
          'sys.stdout.buffer.write(sys.stdin.buffer.read()); ' +
          "sys.stderr.write(json.dumps([os.getcwd(),os.environ['MARK'],sys.argv[1:]])); sys.exit(23)",
        ...words,
      ]
      const result = await agent.shell(
        'MARK=' + singleQuote(marker) + ' ' + argv.map(singleQuote).join(' '),
        { cwd: prefix, stdin: input },
      )
      assert.deepEqual(Buffer.from(result.stdout), Buffer.from(input))
      assert.deepEqual(JSON.parse(dec.decode(result.stderr)), [prefix, marker, words])
      assert.equal(result.exitCode, 23)
      const invalid = await runtime.execLine(
        'printf must-not-run',
        null,
        {},
        prefix + '/missing-directory',
      )
      assert.notEqual(invalid.exitCode, 0)
      assert.equal(invalid.stdout.byteLength, 0)
      assert.ok(
        dec.decode(invalid.stderr ?? undefined).startsWith('sh:'),
        dec.decode(invalid.stderr ?? undefined),
      )
      const unusual = prefix + '/quotes \' " $(printf injected) ☃\nline'
      const created = await runtime.execLine(
        ['python3', '-c', 'import os,sys; os.makedirs(sys.argv[1], exist_ok=True)', unusual]
          .map(singleQuote)
          .join(' '),
        null,
        {},
        '/',
      )
      assert.equal(created.exitCode, 0, dec.decode(created.stderr ?? undefined))
      const literalCwd = await runtime.execLine(
        [
          'python3',
          '-c',
          "import os,sys; assert os.getcwd()==sys.argv[1]; print('literal-cwd')",
          unusual,
        ]
          .map(singleQuote)
          .join(' '),
        null,
        { CDPATH: '/tmp' },
        unusual,
      )
      assert.equal(literalCwd.exitCode, 0, dec.decode(literalCwd.stderr ?? undefined))
      assert.equal(dec.decode(literalCwd.stdout), 'literal-cwd\n')
    })
    await check(
      mountType + '_filesystem_binary_seek_append_truncate_rename_unlink_tools',
      async () => {
        assert.deepEqual(await probe('filesystem'), {
          sha256: hash(payload.slice(0, 1048576)),
          bytes: 1048576,
        })
        if (mountType === 'fuse') {
          const receipt = await raw("mirage shell -w e2e -c 'cat /e2e-guest/receipt.txt'")
          assert.equal(receipt.exitCode, 0, dec.decode(receipt.stderr ?? undefined))
          assert.equal(dec.decode(receipt.stdout), 'guest-filesystem-verified\n')
          assert.equal((await ws.shell('cat /e2e-guest/seed.txt')).stdoutText, 'host-only\n')
        } else {
          assert.equal(
            (await ws.shell('cat ' + singleQuote(prefix + '/receipt.txt'))).stdoutText,
            'guest-filesystem-verified\n',
          )
        }
      },
    )
    await check(mountType + '_symlinks_relative_absolute_dangling', () =>
      probe('symlinks', mountType === 'fuse' ? ' scoped' : ''),
    )
    await check(mountType + '_threads', () => probe('threads'))
    await check(mountType + '_readonly', () => probe('readonly'))
    if (mountType !== 'fuse') {
      await check(mountType + '_hidden_file', () => probe('hidden'))
      await check(mountType + '_host_change_visible', async () => {
        assert.deepEqual(await probe('seed'), { seed: 'seed\n' })
        await source.write(PathSpec.fromStrPath('/seed.txt'), enc.encode('changed\n'))
        assert.deepEqual(await probe('seed'), { seed: 'changed\n' })
      })
    }
    await check(mountType + '_parallel_processes', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => probe('parallel', ` ${i}`)),
      )
      assert.deepEqual(
        results.map((r) => r.index),
        Array.from({ length: 6 }, (_, i) => String(i)),
      )
      assert.ok(results.every((r) => Number(r.end) > Number(r.start)))
    })
    await check(mountType + '_workspace_binary_stdin_stderr_exit', async () => {
      const input = Uint8Array.from({ length: 1048576 }, (_, i) => (i % 2 === 0 ? 0 : 255))
      const result = await agent.shell(
        `python3 -c 'import sys; d=sys.stdin.buffer.read(); sys.stdout.buffer.write(d); sys.stderr.write("separate"); sys.exit(7)'`,
        { stdin: input, cwd: '/' },
      )
      assert.deepEqual(Buffer.from(result.stdout), Buffer.from(input))
      assert.equal(result.stderrText, 'separate')
      assert.equal(result.exitCode, 7)
    })
    await check(mountType + '_session_policy', async () => {
      const other = await ws.session('other', mountType === 'fuse' ? { profile: 'hidden' } : {})
      const result = await other.shell(`python3 -c 'print("must not run")'`)
      assert.equal(result.exitCode, 1)
      assert.ok(
        result.stderrText.includes(mountType === 'fuse' ? 'out of reach' : "session agent's view"),
      )
    })
    if (mountType === 'both') {
      await check('both_guest_mount_retained', async () => {
        const result = await agent.shell(
          `python3 -c 'from pathlib import Path; print(Path("/e2e-guest/seed.txt").read_text(),end="")'`,
        )
        assert.equal(result.exitCode, 0, result.stderrText)
        assert.equal(result.stdoutText, 'seed\n')
      })
    }
  } finally {
    await ws.close()
  }
  await check(mountType + '_mount_and_process_cleanup', async () => {
    const result = await raw('mountpoint -q ' + singleQuote(prefix))
    if (mountType === 'fuse') assert.equal(result.exitCode, 0)
    else assert.notEqual(result.exitCode, 0)
    assert.equal((await raw('mountpoint -q /e2e-guest')).exitCode, 0)
    assert.equal((await raw('pgrep -x sshfs')).exitCode, 1)
  })
}

async function cycles() {
  for (let i = 0; i < 3; i++) {
    const ws = new Workspace(
      { [host]: new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [
          new MicrosandboxRuntime({ captures: ['python3'], config: { sandbox, mountType: 'ssh' } }),
          'workspace',
        ],
      },
    )
    try {
      const result = await ws.shell(`python3 -c 'print("cycle")'`)
      assert.equal(result.exitCode, 0, result.stderrText)
      assert.equal(result.stdoutText, 'cycle\n')
    } finally {
      await ws.close()
    }
    assert.equal((await raw('pgrep -x sshfs')).exitCode, 1)
  }
}

const execHost = promisify(execFile)
async function local(executable: string, ...args: string[]) {
  return (await execHost(executable, args, { timeout: 20000, maxBuffer: 4194304 })).stdout
}

async function guestPid(path: string): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const result = await raw('cat ' + singleQuote(path))
    if (result.exitCode === 0) return Number(dec.decode(result.stdout))
    await delay(50)
  }
  throw new Error('guest command never started')
}

async function reaped(pid: number) {
  for (let i = 0; i < 60; i++) {
    if ((await raw(`test ! -e /proc/${pid}`)).exitCode === 0) return
    await delay(50)
  }
  throw new Error(`guest child ${pid} survived cleanup`)
}

async function hostPids(marker: string) {
  const listing = await local('ps', '-axo', 'pid=,command=')
  return listing.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return match &&
      (match[2] === 'msb' || match[2]!.endsWith('/msb')) &&
      line.includes(sandbox) &&
      line.includes('--stream') &&
      line.includes(marker)
      ? [Number(match[1])]
      : []
  })
}

async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

class FullInspect extends MicrosandboxRuntime {
  protected override microsandbox(
    args: string[],
    stdin: Uint8Array | null = null,
    signal?: AbortSignal,
  ) {
    return super.microsandbox(
      args[0] === 'status' ? ['inspect', ...args.slice(1)] : args,
      stdin,
      signal,
    )
  }
}

async function inspectPids() {
  return (await local('ps', '-axo', 'pid=,command=')).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return match &&
      (match[2] === 'msb' || match[2]?.endsWith('/msb')) &&
      match[3]?.startsWith('inspect ' + sandbox + ' ')
      ? [Number(match[1])]
      : []
  })
}

class StopAfterProbe extends MicrosandboxRuntime {
  override async connect() {
    await super.connect()
    await local('msb', 'stop', sandbox, '--timeout', '10')
  }
}

async function lifecycleChecks() {
  const runtime = new MicrosandboxRuntime({ config: { sandbox } })
  await check('storage_lock_does_not_block_exec_and_cancel_reaps_probe', async () => {
    const digest = hash(enc.encode(sandbox)).slice(0, 32)
    const lock = join(
      process.env.MSB_HOME ?? join(homedir(), '.microsandbox'),
      'run',
      'creation-locks',
      digest + '.lock',
    )
    const locker = spawn(
      'python3',
      [
        '-c',
        "import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked',flush=True); sys.stdin.read()",
        lock,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const locked = once(locker.stdout, 'data')
    const ended = once(locker, 'close')
    const controller = new AbortController()
    let pending: Promise<unknown> = Promise.resolve()
    try {
      await within(locked, 3000)
      const result = await within(raw('printf runtime-probe-ok'), 5000)
      assert.equal(result.exitCode, 0, dec.decode(result.stderr ?? undefined))
      assert.equal(dec.decode(result.stdout), 'runtime-probe-ok')
      pending = new FullInspect({ config: { sandbox } }).execute(
        [],
        ['true'],
        {
          flags: {},
          cwd: PathSpec.fromStrPath('/'),
          env: {},
          stdin: null,
          signal: controller.signal,
        },
        { kind: 'process' },
      )
      const refused = assert.rejects(pending, (error: Error) => error.name === 'AbortError')
      for (let i = 0; i < 80 && (await inspectPids()).length === 0; i++) await delay(25)
      assert.equal((await inspectPids()).length, 1, 'real msb inspect did not start')
      controller.abort()
      await within(refused, 3000)
      for (let i = 0; i < 80 && (await inspectPids()).length > 0; i++) await delay(25)
      assert.deepEqual(await inspectPids(), [], 'cancelled inspect process survived')
    } finally {
      controller.abort()
      await pending.catch(() => {})
      for (const pid of await inspectPids()) process.kill(pid, 'SIGKILL')
      locker.stdin.end()
      locker.kill()
      await within(ended, 3000)
    }
  })
  await check('pipe_bounded_stderr_diagnostic', async () => {
    const pipe = await runtime.openPipe(
      `python3 -c 'import sys; sys.stderr.write("X"*32768+"specific-startup-error"); sys.exit(31)'`,
    )
    const reader = pipe.reader.getReader()
    try {
      assert.equal((await within(reader.read(), 10000)).done, true)
      for (
        let i = 0;
        i < 20 && !(await pipe.diagnostic?.())?.includes('specific-startup-error');
        i++
      )
        await delay(50)
      assert.ok((await pipe.diagnostic?.())?.includes('specific-startup-error'))
      assert.ok(Buffer.byteLength(await pipe.diagnostic!()) <= 16384)
    } finally {
      reader.releaseLock()
      await pipe.stop()
    }
  })
  await check('stopped_cli_forced_kill_and_guest_cleanup', async () => {
    const marker = 'mirage-stop-' + randomUUID()
    const path = '/tmp/' + marker
    const pipe = await runtime.openPipe(`echo $$ > ${path}; exec sleep 30`)
    try {
      const pid = await guestPid(path)
      const hosts = await hostPids(marker)
      assert.equal(hosts.length, 1)
      process.kill(hosts[0]!, 'SIGSTOP')
      await within(pipe.stop(), 8000)
      assert.deepEqual(await hostPids(marker), [])
      await reaped(pid)
    } finally {
      for (const host of await hostPids(marker)) process.kill(host, 'SIGCONT')
      await pipe.stop()
    }
  })
  await check('cancelled_execution_reaps_guest', async () => {
    const path = '/tmp/mirage-cancel-' + randomUUID()
    const controller = new AbortController()
    const pending = runtime.execLine(
      `echo $$ > ${path}; exec sleep 30`,
      null,
      {},
      '/',
      controller.signal,
    )
    try {
      const pid = await guestPid(path)
      controller.abort()
      await assert.rejects(within(pending, 5000), (error: Error) => error.name === 'AbortError')
      await reaped(pid)
    } finally {
      controller.abort()
      await pending.catch(() => {})
    }
  })
  await check('missing_fuse_device_preserves_sshfs_error', async () => {
    const ws = new Workspace(
      { '/missing-fuse': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [
          new MicrosandboxRuntime({ captures: ['python3'], config: { sandbox, mountType: 'ssh' } }),
          'workspace',
        ],
      },
    )
    const moved = await raw(
      'test -c /dev/fuse && test ! -e /dev/fuse-mirage-e2e && mv /dev/fuse /dev/fuse-mirage-e2e',
    )
    assert.equal(moved.exitCode, 0, dec.decode(moved.stderr ?? undefined))
    try {
      const result = await ws.shell("python3 -c 'print(1)'")
      assert.equal(result.exitCode, 1)
      assert.ok(
        dec.decode(result.stderr ?? undefined).includes('fuse: device not found'),
        dec.decode(result.stderr ?? undefined),
      )
    } finally {
      const restored = await raw('mv /dev/fuse-mirage-e2e /dev/fuse')
      assert.equal(restored.exitCode, 0, dec.decode(restored.stderr ?? undefined))
      await ws.close()
    }
  })
  for (const mountType of [null, 'ssh', 'both'] as const) {
    await check(`${mountType}_cached_runtime_refuses_guest_stopped_before_probe`, async () => {
      const runtime = new MicrosandboxRuntime({ config: { sandbox, mountType } })
      assert.equal((await runtime.execLine('true', null, {}, '/')).exitCode, 0)
      await local('msb', 'stop', sandbox, '--timeout', '10')
      try {
        await assert.rejects(runtime.execLine('printf must-not-run', null, {}, '/'), /not running/)
        await assert.rejects(runtime.openPipe('printf must-not-run'), /not running/)
        assert.equal(
          JSON.parse(await local('msb', 'inspect', sandbox, '--format', 'json')).status,
          'Stopped',
        )
      } finally {
        await local('msb', 'start', sandbox)
        await runtime.close()
      }
    })
    await check(`${mountType}_released_cli_can_restart_after_probe`, async () => {
      const candidate = new StopAfterProbe({ config: { sandbox, mountType } })
      try {
        const pipe = await candidate.openPipe('printf race-command-ran')
        const reader = pipe.reader.getReader()
        try {
          const chunks: Uint8Array[] = []
          for (;;) {
            const { done, value } = await within(reader.read(), 15000)
            if (done) break
            chunks.push(value)
          }
          assert.equal(Buffer.concat(chunks).toString(), 'race-command-ran')
          await pipe.stop()
          assert.ok(!(await pipe.diagnostic?.())?.includes('not running'))
        } finally {
          reader.releaseLock()
          await pipe.stop()
        }
        assert.equal(
          JSON.parse(await local('msb', 'inspect', sandbox, '--format', 'json')).status,
          'Stopped',
        )
      } finally {
        await local('msb', 'start', sandbox)
      }
    })
  }
}

if (process.env.MIRAGE_E2E_AGENTD) {
  const expected = hash(await readFile(process.env.MIRAGE_E2E_AGENTD))
  assert.equal(dec.decode((await raw('sha256sum /proc/1/exe')).stdout).split(' ')[0], expected)
}
assert.equal((await raw('mountpoint -q /e2e-guest')).exitCode, 0, 'guest FUSE setup missing')
await check('raw_4MiB_stdin_argv_env_cwd_large_output', transport)
for (const mode of ['fuse', 'ssh', 'both'] as const) await modeChecks(mode)
await check('three_mount_close_cycles', cycles)
await lifecycleChecks()
console.log(JSON.stringify({ host: 'typescript', passed: passed.length, failed }))
process.exitCode = failed.length > 0 ? 1 : 0

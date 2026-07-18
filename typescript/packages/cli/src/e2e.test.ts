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

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const cliBin = join(here, '..', 'dist', 'bin', 'mirage.js')

const PORT = 18766
const ISOLATED_PORT = 18767

function writeRamConfig(dir: string, name: string, mode = 'write'): string {
  const cfgPath = join(dir, name)
  writeFileSync(cfgPath, `mounts:\n  /:\n    resource: ram\n    mode: ${mode}\n`)
  return cfgPath
}

function cliEnv(port = PORT): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.MIRAGE_DAEMON_URL = `http://127.0.0.1:${String(port)}`
  env.MIRAGE_IDLE_GRACE_SECONDS = '120'
  return env
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
  parsed: unknown
}

// Spawn the CLI ASYNCHRONOUSLY (not spawnSync). Blocking spawnSync would freeze
// the vitest worker's event loop for the whole suite, so on slow CI the
// worker's onTaskUpdate RPC (60s birpc timeout) fires before its ack can be
// processed. Awaiting an async child keeps the loop responsive between calls.
function execCli(
  env: Record<string, string>,
  args: string[],
  stdin?: string | Uint8Array,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, ...args], { env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const trimmed = stdout.trim()
      let parsed: unknown = {}
      if (trimmed !== '') {
        try {
          parsed = JSON.parse(trimmed) as unknown
        } catch {
          parsed = trimmed
        }
      }
      resolve({ status, stdout, stderr, parsed })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 30000)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', () => {
      finish(null)
    })
    child.on('close', (code) => {
      finish(code)
    })
    child.stdin.on('error', () => {
      // ignore EPIPE if the child closes stdin before we finish writing
    })
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

async function runCli(
  env: Record<string, string>,
  args: string[],
  stdin?: string | Uint8Array,
): Promise<unknown> {
  const r = await execCli(env, args, stdin)
  if (r.status !== 0) {
    throw new Error(
      `mirage ${args.join(' ')} exited ${String(r.status)}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    )
  }
  const trimmed = r.stdout.trim()
  if (trimmed === '') return {}
  return JSON.parse(trimmed) as unknown
}

function runCliRaw(
  env: Record<string, string>,
  args: string[],
  stdin?: string | Uint8Array,
): Promise<CliResult> {
  return execCli(env, args, stdin)
}

async function stopDaemon(env: Record<string, string>): Promise<void> {
  await execCli(env, ['daemon', 'stop'])
}

describe('mirage CLI end-to-end', () => {
  let tmp: string
  let env: Record<string, string>

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mirage-e2e-'))
    env = cliEnv()
    env.MIRAGE_HOME = tmp
  })

  afterAll(async () => {
    await stopDaemon(env)
    await stopDaemon(cliEnv(ISOLATED_PORT))
    rmSync(tmp, { recursive: true, force: true })
  })

  it('workspace lifecycle works end-to-end', async () => {
    const cfgPath = writeRamConfig(tmp, 'config.yaml')

    const created = (await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )

    const listed = (await runCli(env, ['workspace', 'list'])) as { id: string }[]
    expect(listed.some((w) => w.id === created.id)).toBe(true)

    const exec = (await runCli(env, ['execute', '-w', created.id, '-c', 'echo hello world'])) as {
      stdout: string
    }
    expect(exec.stdout.trim()).toBe('hello world')

    const deleted = (await runCli(env, ['workspace', 'delete', created.id])) as { id: string }
    expect(deleted.id).toBe(created.id)
  }, 30000)

  it('workspace create supports explicit ids', async () => {
    const cfgPath = writeRamConfig(tmp, 'explicit-id.yaml')

    const created = (await runCli(env, [
      'workspace',
      'create',
      cfgPath,
      '--id',
      'explicit-ts',
    ])) as {
      id: string
    }
    expect(created.id).toBe('explicit-ts')

    const got = (await runCli(env, ['workspace', 'get', 'explicit-ts'])) as { id: string }
    expect(got.id).toBe('explicit-ts')

    await runCli(env, ['workspace', 'delete', 'explicit-ts'])
  }, 30000)

  it('session lifecycle works end-to-end', async () => {
    const cfgPath = writeRamConfig(tmp, 'session-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'session-ws'])) as {
      id: string
    }
    expect(created.id).toBe('session-ws')

    const session = (await runCli(env, ['session', 'create', 'session-ws', '--id', 'agent_a'])) as {
      sessionId: string
      cwd: string
    }
    expect(session.sessionId).toBe('agent_a')
    expect(session.cwd).toBe('/')

    const listed = (await runCli(env, ['session', 'list', 'session-ws'])) as { sessionId: string }[]
    expect(listed.some((s) => s.sessionId === 'agent_a')).toBe(true)

    const deleted = (await runCli(env, ['session', 'delete', 'session-ws', 'agent_a'])) as {
      sessionId: string
    }
    expect(deleted.sessionId).toBe('agent_a')

    await runCli(env, ['workspace', 'delete', 'session-ws'])
  }, 30000)

  it('execute returns json io results', async () => {
    const cfgPath = writeRamConfig(tmp, 'exec-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'exec-json'])) as {
      id: string
    }
    expect(created.id).toBe('exec-json')

    const result = (await runCli(env, ['execute', '-w', 'exec-json', '-c', 'echo json-out'])) as {
      kind: string
      exitCode: number
      stdout: string
    }
    expect(result.kind).toBe('io')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('json-out')

    await runCli(env, ['workspace', 'delete', 'exec-json'])
  }, 30000)

  it('execute consumes piped stdin', async () => {
    const cfgPath = writeRamConfig(tmp, 'stdin-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'stdin-ws'])) as {
      id: string
    }
    expect(created.id).toBe('stdin-ws')

    const result = (await runCli(
      env,
      ['execute', '-w', 'stdin-ws', '-c', 'wc -l'],
      'a\nb\nc\n',
    )) as {
      kind: string
      exitCode: number
      stdout: string
    }
    expect(result.kind).toBe('io')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^3\b/)

    await runCli(env, ['workspace', 'delete', 'stdin-ws'])
  }, 30000)

  it('execute propagates inner exit code to process exit', async () => {
    const cfgPath = writeRamConfig(tmp, 'exit-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }

    const ok = await runCliRaw(env, ['execute', '-w', created.id, '-c', 'true'])
    expect(ok.status).toBe(0)

    const fail = await runCliRaw(env, ['execute', '-w', created.id, '-c', 'false'])
    expect(fail.status).toBe(1)
    expect((fail.parsed as { exitCode: number }).exitCode).toBe(1)

    const pipeNoFail = await runCliRaw(env, ['execute', '-w', created.id, '-c', 'false | true'])
    expect(pipeNoFail.status).toBe(0)

    const pipeFail = await runCliRaw(env, [
      'execute',
      '-w',
      created.id,
      '-c',
      'set -o pipefail; false | true',
    ])
    expect(pipeFail.status).toBe(1)

    const bg = await runCliRaw(env, ['execute', '-w', created.id, '--bg', '-c', 'false'])
    expect(bg.status).toBe(0)
    const jobId = (bg.parsed as { jobId: string }).jobId
    expect(jobId).toMatch(/^job_/)

    const waited = await runCliRaw(env, ['job', 'wait', jobId])
    expect(waited.status).toBe(1)
    const result = (waited.parsed as { result: { exitCode: number } }).result
    expect(result.exitCode).toBe(1)

    await runCli(env, ['workspace', 'delete', created.id])
  }, 30000)

  it('background execution can be waited on', async () => {
    const cfgPath = writeRamConfig(tmp, 'bg-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'bg-ws'])) as {
      id: string
    }
    expect(created.id).toBe('bg-ws')

    const submitted = (await runCli(env, [
      'execute',
      '-w',
      'bg-ws',
      '--bg',
      '-c',
      'echo from-bg',
    ])) as {
      jobId: string
    }
    expect(submitted.jobId).toMatch(/^job_/)

    const waited = (await runCli(env, ['job', 'wait', submitted.jobId])) as {
      status: string
      result: { kind: string; exitCode: number; stdout: string }
    }
    expect(waited.status).toBe('done')
    expect(waited.result.kind).toBe('io')
    expect(waited.result.exitCode).toBe(0)
    expect(waited.result.stdout.trim()).toBe('from-bg')

    await runCli(env, ['workspace', 'delete', 'bg-ws'])
  }, 30000)

  it('workspace get verbose includes daemon internals', async () => {
    const cfgPath = writeRamConfig(tmp, 'verbose-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'verbose-ws'])) as {
      id: string
    }
    expect(created.id).toBe('verbose-ws')

    const plain = (await runCli(env, ['workspace', 'get', 'verbose-ws'])) as {
      internals: unknown
      mounts: unknown[]
      sessions: unknown[]
    }
    expect(plain.mounts).toHaveLength(1)
    expect(plain.sessions).toHaveLength(1)
    expect(plain.internals).toBeNull()

    const verbose = (await runCli(env, ['workspace', 'get', 'verbose-ws', '--verbose'])) as {
      internals: { cacheBytes: number; cacheEntries: number; historyLength: number }
    }
    expect(verbose.internals.cacheBytes).toBeGreaterThanOrEqual(0)
    expect(verbose.internals.cacheEntries).toBeGreaterThanOrEqual(0)
    expect(verbose.internals.historyLength).toBeGreaterThanOrEqual(0)

    await runCli(env, ['workspace', 'delete', 'verbose-ws'])
  }, 30000)

  it('unknown workspace exits nonzero', async () => {
    const missing = await runCliRaw(env, ['workspace', 'get', 'does-not-exist'])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('daemon error 404')
  }, 30000)

  it('workspace config interpolation uses CLI environment', async () => {
    const cfgPath = join(tmp, 'env-cfg.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: ${MIRAGE_E2E_MODE}\n')
    const useEnv = { ...env, MIRAGE_E2E_MODE: 'write' }

    const created = (await runCli(useEnv, ['workspace', 'create', cfgPath, '--id', 'env-ws'])) as {
      id: string
    }
    expect(created.id).toBe('env-ws')

    const got = (await runCli(useEnv, ['workspace', 'get', 'env-ws'])) as {
      mounts: { mode: string }[]
    }
    expect(got.mounts[0]?.mode).toBe('write')

    await runCli(useEnv, ['workspace', 'delete', 'env-ws'])
  }, 30000)

  it('daemon status reports the running daemon', async () => {
    const status = (await runCli(env, ['daemon', 'status'])) as {
      running: boolean
      url: string
      workspaces: number
    }
    expect(status.running).toBe(true)
    expect(status.url).toBe(env.MIRAGE_DAEMON_URL)
    expect(status.workspaces).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('daemon stop makes status fail on an isolated port', async () => {
    const stopEnv = cliEnv(ISOLATED_PORT)
    const cfgPath = writeRamConfig(tmp, 'daemon-stop-cfg.yaml')
    const created = (await runCli(stopEnv, [
      'workspace',
      'create',
      cfgPath,
      '--id',
      'daemon-stop-ws',
    ])) as {
      id: string
    }
    expect(created.id).toBe('daemon-stop-ws')

    const running = (await runCli(stopEnv, ['daemon', 'status'])) as {
      running: boolean
      url: string
    }
    expect(running.running).toBe(true)
    expect(running.url).toBe(stopEnv.MIRAGE_DAEMON_URL)

    const stopped = (await runCli(stopEnv, ['daemon', 'stop'])) as { stopped: boolean }
    expect(stopped.stopped).toBe(true)

    const status = await runCliRaw(stopEnv, ['daemon', 'status'])
    expect(status.status).toBe(1)
    expect((status.parsed as { running: boolean }).running).toBe(false)
  }, 30000)

  it('provision returns a dry-run result', async () => {
    const cfgPath = writeRamConfig(tmp, 'provision-cfg.yaml')
    const created = (await runCli(env, [
      'workspace',
      'create',
      cfgPath,
      '--id',
      'provision-ws',
    ])) as {
      id: string
    }
    expect(created.id).toBe('provision-ws')

    const result = (await runCli(env, [
      'provision',
      '-w',
      'provision-ws',
      '-c',
      'echo planned',
    ])) as {
      kind: string
    }
    expect(result.kind).toBe('provision')

    await runCli(env, ['workspace', 'delete', 'provision-ws'])
  }, 30000)

  it('subshell cwd changes do not leak', async () => {
    const cfgPath = writeRamConfig(tmp, 'cwd-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'cwd-ws'])) as {
      id: string
    }
    expect(created.id).toBe('cwd-ws')

    await runCli(env, ['execute', '-w', 'cwd-ws', '-c', 'mkdir /sub'])
    const inner = (await runCli(env, ['execute', '-w', 'cwd-ws', '-c', '(cd /sub && pwd)'])) as {
      stdout: string
    }
    expect(inner.stdout.trim()).toBe('/sub')

    const outer = (await runCli(env, ['execute', '-w', 'cwd-ws', '-c', 'pwd'])) as {
      stdout: string
    }
    expect(outer.stdout.trim()).toBe('/')

    await runCli(env, ['workspace', 'delete', 'cwd-ws'])
  }, 30000)

  it('subshell env changes do not leak', async () => {
    const cfgPath = writeRamConfig(tmp, 'env-prefix-cfg.yaml')
    const created = (await runCli(env, [
      'workspace',
      'create',
      cfgPath,
      '--id',
      'env-prefix-ws',
    ])) as {
      id: string
    }
    expect(created.id).toBe('env-prefix-ws')

    const inner = (await runCli(env, [
      'execute',
      '-w',
      'env-prefix-ws',
      '-c',
      '(export FOO=bar; printenv FOO)',
    ])) as { stdout: string }
    expect(inner.stdout.trim()).toBe('bar')

    const outer = (await runCli(env, [
      'execute',
      '-w',
      'env-prefix-ws',
      '-c',
      'printenv FOO || echo absent',
    ])) as { stdout: string }
    expect(outer.stdout.trim()).toBe('absent')

    await runCli(env, ['workspace', 'delete', 'env-prefix-ws'])
  }, 30000)

  it('background jobs can be canceled', async () => {
    const cfgPath = writeRamConfig(tmp, 'cancel-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'cancel-ws'])) as {
      id: string
    }
    expect(created.id).toBe('cancel-ws')

    const submitted = (await runCli(env, [
      'execute',
      '-w',
      'cancel-ws',
      '--bg',
      '-c',
      'sleep 30',
    ])) as {
      jobId: string
    }
    expect(submitted.jobId).toMatch(/^job_/)

    const canceled = (await runCli(env, ['job', 'cancel', submitted.jobId])) as {
      jobId: string
      canceled: boolean
    }
    expect(canceled.jobId).toBe(submitted.jobId)
    expect(canceled.canceled).toBe(true)

    const waited = await runCliRaw(env, ['job', 'wait', submitted.jobId])
    expect(waited.status).toBe(2)
    expect((waited.parsed as { status: string }).status).toBe('canceled')

    await runCli(env, ['workspace', 'delete', 'cancel-ws'])
  }, 30000)

  it('missing config env vars fail before workspace creation', async () => {
    const cfgPath = join(tmp, 'missing-env-cfg.yaml')
    writeFileSync(
      cfgPath,
      'mounts:\n  /:\n    resource: ram\n    mode: ${MIRAGE_E2E_MISSING_MODE}\n',
    )
    const useEnv = { ...env }
    delete useEnv.MIRAGE_E2E_MISSING_MODE

    const result = await runCliRaw(useEnv, [
      'workspace',
      'create',
      cfgPath,
      '--id',
      'missing-env-ws',
    ])
    expect(result.status).not.toBe(0)

    const listed = (await runCli(env, ['workspace', 'list'])) as { id: string }[]
    expect(listed.some((w) => w.id === 'missing-env-ws')).toBe(false)
  }, 30000)

  it('workspace snapshot + load round-trips', async () => {
    const cfgPath = writeRamConfig(tmp, 'round-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'round-ws'])) as {
      id: string
    }
    expect(created.id).toBe('round-ws')

    const tarPath = join(tmp, 'snapshots', 'round.tar')
    mkdirSync(join(tmp, 'snapshots'), { recursive: true })
    await runCli(env, ['workspace', 'snapshot', 'round-ws', tarPath])
    expect(existsSync(tarPath)).toBe(true)

    await runCli(env, ['workspace', 'delete', 'round-ws'])

    const loaded = (await runCli(env, [
      'workspace',
      'load',
      tarPath,
      cfgPath,
      '--id',
      'reloaded',
    ])) as {
      id: string
    }
    expect(loaded.id).toBe('reloaded')

    const listed = (await runCli(env, ['workspace', 'list'])) as { id: string }[]
    expect(listed.some((w) => w.id === 'reloaded')).toBe(true)
  }, 30000)

  // The tests below mirror python/tests/cli/test_version_cmds.py 1:1.

  it('commit / log / checkout / clone', async () => {
    const cfgPath = join(tmp, 'ver-clc.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo v1 > /notes.txt'])
    const v1 = (
      (await runCli(env, ['workspace', 'commit', id, '-m', 'first'])) as {
        version: string
      }
    ).version
    await runCli(env, ['execute', '-w', id, '-c', 'echo v2 > /notes.txt'])
    await runCli(env, ['workspace', 'commit', id, '-m', 'second'])

    const log = (await runCli(env, ['workspace', 'log', id])) as { message: string }[]
    expect(log.map((e) => e.message)).toEqual(['second', 'first'])

    await runCli(env, ['workspace', 'checkout', id, v1])
    const reverted = (await runCli(env, ['execute', '-w', id, '-c', 'cat /notes.txt'])) as {
      stdout: string
    }
    expect(reverted.stdout).toBe('v1\n')

    const clone = (await runCli(env, ['workspace', 'clone', id, '--at', v1])) as { id: string }
    expect(clone.id).not.toBe(id)

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('log is empty before first commit', async () => {
    const cfgPath = join(tmp, 'ver-empty.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id
    expect(await runCli(env, ['workspace', 'log', id])).toEqual([])
    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('diff versions and live', async () => {
    const cfgPath = join(tmp, 'ver-diff.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    const v1 = (
      (await runCli(env, ['workspace', 'commit', id, '-m', 'first'])) as {
        version: string
      }
    ).version

    await runCli(env, ['execute', '-w', id, '-c', 'echo two > /a.txt'])
    await runCli(env, ['execute', '-w', id, '-c', 'echo new > /b.txt'])
    const v2 = (
      (await runCli(env, ['workspace', 'commit', id, '-m', 'second'])) as {
        version: string
      }
    ).version

    const byVersion = (await runCli(env, ['workspace', 'diff', id, v1, v2])) as {
      modified: string[]
      added: string[]
    }
    expect(byVersion.modified).toEqual(['a.txt'])
    expect(byVersion.added).toEqual(['b.txt'])

    await runCli(env, ['execute', '-w', id, '-c', 'echo three > /a.txt'])
    const live = (await runCli(env, ['workspace', 'diff', id])) as { modified: string[] }
    expect(live.modified).toEqual(['a.txt'])

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('branch diverges and guards commit', async () => {
    const cfgPath = join(tmp, 'ver-branch.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-m', 'first'])

    await runCli(env, ['workspace', 'branch', id, 'exp'])
    await runCli(env, ['execute', '-w', id, '-c', 'echo two > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-b', 'exp', '-m', 'on exp'])

    const expLog = (await runCli(env, ['workspace', 'log', id, '-b', 'exp'])) as {
      message: string
    }[]
    const mainLog = (await runCli(env, ['workspace', 'log', id, '-b', 'main'])) as {
      message: string
    }[]
    expect(expLog.map((e) => e.message)).toEqual(['on exp', 'first'])
    expect(mainLog.map((e) => e.message)).toEqual(['first'])

    // Daemon errors exit 2 (handleResponse), same as Python.
    const ghost = await runCliRaw(env, ['workspace', 'commit', id, '-b', 'ghost', '-m', 'x'])
    expect(ghost.status).toBe(2)

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('diff includes deleted', async () => {
    const cfgPath = join(tmp, 'ver-del.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    await runCli(env, ['execute', '-w', id, '-c', 'echo two > /b.txt'])
    const v1 = (
      (await runCli(env, ['workspace', 'commit', id, '-m', 'first'])) as {
        version: string
      }
    ).version

    await runCli(env, ['execute', '-w', id, '-c', 'rm /b.txt'])
    const v2 = (
      (await runCli(env, ['workspace', 'commit', id, '-m', 'second'])) as {
        version: string
      }
    ).version

    const changes = (await runCli(env, ['workspace', 'diff', id, v1, v2])) as { deleted: string[] }
    expect(changes.deleted).toEqual(['b.txt'])

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('clone live and explicit id', async () => {
    const cfgPath = join(tmp, 'ver-clone.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id
    await runCli(env, ['execute', '-w', id, '-c', 'echo hello > /a.txt'])

    const auto = (await runCli(env, ['workspace', 'clone', id])) as { id: string }
    expect(auto.id).not.toBe(id)

    const named = (await runCli(env, ['workspace', 'clone', id, '--id', 'myclone'])) as {
      id: string
    }
    expect(named.id).toBe('myclone')
    const got = (await runCli(env, ['execute', '-w', 'myclone', '-c', 'cat /a.txt'])) as {
      stdout: string
    }
    expect(got.stdout).toBe('hello\n')

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('branch --from non-main', async () => {
    const cfgPath = join(tmp, 'ver-from.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-m', 'first'])
    await runCli(env, ['workspace', 'branch', id, 'exp'])
    await runCli(env, ['execute', '-w', id, '-c', 'echo two > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-b', 'exp', '-m', 'on exp'])

    await runCli(env, ['workspace', 'branch', id, 'exp2', '--from', 'exp'])
    const log = (await runCli(env, ['workspace', 'log', id, '-b', 'exp2'])) as { message: string }[]
    expect(log.map((e) => e.message)).toEqual(['on exp', 'first'])

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('checkout by branch name', async () => {
    const cfgPath = join(tmp, 'ver-co.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id

    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-m', 'first'])
    await runCli(env, ['workspace', 'branch', id, 'exp'])
    await runCli(env, ['execute', '-w', id, '-c', 'echo two > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-b', 'exp', '-m', 'on exp'])

    await runCli(env, ['workspace', 'checkout', id, 'main'])
    const onMain = (await runCli(env, ['execute', '-w', id, '-c', 'cat /a.txt'])) as {
      stdout: string
    }
    expect(onMain.stdout).toBe('one\n')

    await runCli(env, ['workspace', 'checkout', id, 'exp'])
    const onExp = (await runCli(env, ['execute', '-w', id, '-c', 'cat /a.txt'])) as {
      stdout: string
    }
    expect(onExp.stdout).toBe('two\n')

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('error paths exit 2', async () => {
    const cfgPath = join(tmp, 'ver-err.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const id = ((await runCli(env, ['workspace', 'create', cfgPath])) as { id: string }).id
    await runCli(env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    await runCli(env, ['workspace', 'commit', id, '-m', 'first'])
    await runCli(env, ['workspace', 'branch', id, 'exp'])

    expect((await runCliRaw(env, ['workspace', 'branch', id, 'exp'])).status).toBe(2)
    expect((await runCliRaw(env, ['workspace', 'commit', 'ghost-ws', '-m', 'x'])).status).toBe(2)
    expect((await runCliRaw(env, ['workspace', 'checkout', id, 'nope'])).status).toBe(2)
    expect((await runCliRaw(env, ['workspace', 'diff', id, 'nope', 'nope2'])).status).toBe(2)

    await runCli(env, ['workspace', 'delete', id])
  }, 30000)

  it('workspace clone round-trips', async () => {
    const cfgPath = writeRamConfig(tmp, 'clone-cfg.yaml')
    const created = (await runCli(env, ['workspace', 'create', cfgPath, '--id', 'clone-src'])) as {
      id: string
    }
    expect(created.id).toBe('clone-src')

    await runCli(env, ['execute', '-w', 'clone-src', '-c', 'echo source > /report.txt'])
    const cloned = (await runCli(env, [
      'workspace',
      'clone',
      'clone-src',
      '--id',
      'clone-dst',
    ])) as {
      id: string
    }
    expect(cloned.id).toBe('clone-dst')

    const cloneRead = (await runCli(env, [
      'execute',
      '-w',
      'clone-dst',
      '-c',
      'cat /report.txt',
    ])) as {
      stdout: string
    }
    expect(cloneRead.stdout).toContain('source')

    await runCli(env, ['execute', '-w', 'clone-dst', '-c', 'echo clone > /report.txt'])
    const originalRead = (await runCli(env, [
      'execute',
      '-w',
      'clone-src',
      '-c',
      'cat /report.txt',
    ])) as {
      stdout: string
    }
    expect(originalRead.stdout).toContain('source')

    await runCli(env, ['workspace', 'delete', 'clone-src'])
    await runCli(env, ['workspace', 'delete', 'clone-dst'])
  }, 30000)
})

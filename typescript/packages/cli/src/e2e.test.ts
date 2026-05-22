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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function stopDaemon(env: Record<string, string>): void {
  try {
    spawnSync(process.execPath, [cliBin, 'daemon', 'stop'], {
      env,
      encoding: 'utf-8',
      timeout: 10000,
    })
  } catch {
    // teardown best-effort; test assertions already passed/failed
  }
}

function runCli(env: Record<string, string>, args: string[], stdin?: string | Uint8Array): unknown {
  const r = spawnSync(process.execPath, [cliBin, ...args], {
    env,
    encoding: 'utf-8',
    input: stdin,
    timeout: 30000,
  })
  if (r.status !== 0) {
    throw new Error(
      `mirage ${args.join(' ')} exited ${String(r.status)}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    )
  }
  const trimmed = r.stdout.trim()
  if (trimmed === '') return {}
  return JSON.parse(trimmed) as unknown
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
  parsed: unknown
}

function runCliRaw(
  env: Record<string, string>,
  args: string[],
  stdin?: string | Uint8Array,
): CliResult {
  const r = spawnSync(process.execPath, [cliBin, ...args], {
    env,
    encoding: 'utf-8',
    input: stdin,
    timeout: 30000,
  })
  const trimmed = r.stdout.trim()
  let parsed: unknown = {}
  if (trimmed !== '') {
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      parsed = trimmed
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed }
}

describe('mirage CLI end-to-end', () => {
  let tmp: string
  let env: Record<string, string>

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mirage-e2e-'))
    env = cliEnv()
  })

  afterAll(() => {
    stopDaemon(env)
    stopDaemon(cliEnv(ISOLATED_PORT))
    rmSync(tmp, { recursive: true, force: true })
  })

  it('workspace lifecycle works end-to-end', () => {
    const cfgPath = writeRamConfig(tmp, 'config.yaml')

    const created = runCli(env, ['workspace', 'create', cfgPath]) as { id: string }
    expect(created.id).toMatch(/^ws_/)

    const listed = runCli(env, ['workspace', 'list']) as { id: string }[]
    expect(listed.some((w) => w.id === created.id)).toBe(true)

    const exec = runCli(env, ['execute', '-w', created.id, '-c', 'echo hello world']) as {
      stdout: string
    }
    expect(exec.stdout.trim()).toBe('hello world')

    const deleted = runCli(env, ['workspace', 'delete', created.id]) as { id: string }
    expect(deleted.id).toBe(created.id)
  }, 30000)

  it('workspace create supports explicit ids', () => {
    const cfgPath = writeRamConfig(tmp, 'explicit-id.yaml')

    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'explicit-ts']) as {
      id: string
    }
    expect(created.id).toBe('explicit-ts')

    const got = runCli(env, ['workspace', 'get', 'explicit-ts']) as { id: string }
    expect(got.id).toBe('explicit-ts')

    runCli(env, ['workspace', 'delete', 'explicit-ts'])
  }, 30000)

  it('session lifecycle works end-to-end', () => {
    const cfgPath = writeRamConfig(tmp, 'session-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'session-ws']) as {
      id: string
    }
    expect(created.id).toBe('session-ws')

    const session = runCli(env, ['session', 'create', 'session-ws', '--id', 'agent_a']) as {
      sessionId: string
      cwd: string
    }
    expect(session.sessionId).toBe('agent_a')
    expect(session.cwd).toBe('/')

    const listed = runCli(env, ['session', 'list', 'session-ws']) as { sessionId: string }[]
    expect(listed.some((s) => s.sessionId === 'agent_a')).toBe(true)

    const deleted = runCli(env, ['session', 'delete', 'session-ws', 'agent_a']) as {
      sessionId: string
    }
    expect(deleted.sessionId).toBe('agent_a')

    runCli(env, ['workspace', 'delete', 'session-ws'])
  }, 30000)

  it('execute returns json io results', () => {
    const cfgPath = writeRamConfig(tmp, 'exec-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'exec-json']) as {
      id: string
    }
    expect(created.id).toBe('exec-json')

    const result = runCli(env, ['execute', '-w', 'exec-json', '-c', 'echo json-out']) as {
      kind: string
      exitCode: number
      stdout: string
    }
    expect(result.kind).toBe('io')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('json-out')

    runCli(env, ['workspace', 'delete', 'exec-json'])
  }, 30000)

  it('execute consumes piped stdin', () => {
    const cfgPath = writeRamConfig(tmp, 'stdin-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'stdin-ws']) as {
      id: string
    }
    expect(created.id).toBe('stdin-ws')

    const result = runCli(env, ['execute', '-w', 'stdin-ws', '-c', 'wc -l'], 'a\nb\nc\n') as {
      kind: string
      exitCode: number
      stdout: string
    }
    expect(result.kind).toBe('io')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^3\b/)

    runCli(env, ['workspace', 'delete', 'stdin-ws'])
  }, 30000)

  it('execute propagates inner exit code to process exit', () => {
    const cfgPath = writeRamConfig(tmp, 'exit-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath]) as { id: string }

    const ok = runCliRaw(env, ['execute', '-w', created.id, '-c', 'true'])
    expect(ok.status).toBe(0)

    const fail = runCliRaw(env, ['execute', '-w', created.id, '-c', 'false'])
    expect(fail.status).toBe(1)
    expect((fail.parsed as { exitCode: number }).exitCode).toBe(1)

    const pipeNoFail = runCliRaw(env, ['execute', '-w', created.id, '-c', 'false | true'])
    expect(pipeNoFail.status).toBe(0)

    const pipeFail = runCliRaw(env, [
      'execute',
      '-w',
      created.id,
      '-c',
      'set -o pipefail; false | true',
    ])
    expect(pipeFail.status).toBe(1)

    const bg = runCliRaw(env, ['execute', '-w', created.id, '--bg', '-c', 'false'])
    expect(bg.status).toBe(0)
    const jobId = (bg.parsed as { jobId: string }).jobId
    expect(jobId).toMatch(/^job_/)

    const waited = runCliRaw(env, ['job', 'wait', jobId])
    expect(waited.status).toBe(1)
    const result = (waited.parsed as { result: { exitCode: number } }).result
    expect(result.exitCode).toBe(1)

    runCli(env, ['workspace', 'delete', created.id])
  }, 30000)

  it('background execution can be waited on', () => {
    const cfgPath = writeRamConfig(tmp, 'bg-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'bg-ws']) as {
      id: string
    }
    expect(created.id).toBe('bg-ws')

    const submitted = runCli(env, ['execute', '-w', 'bg-ws', '--bg', '-c', 'echo from-bg']) as {
      jobId: string
    }
    expect(submitted.jobId).toMatch(/^job_/)

    const waited = runCli(env, ['job', 'wait', submitted.jobId]) as {
      status: string
      result: { kind: string; exitCode: number; stdout: string }
    }
    expect(waited.status).toBe('done')
    expect(waited.result.kind).toBe('io')
    expect(waited.result.exitCode).toBe(0)
    expect(waited.result.stdout.trim()).toBe('from-bg')

    runCli(env, ['workspace', 'delete', 'bg-ws'])
  }, 30000)

  it('workspace get verbose includes daemon internals', () => {
    const cfgPath = writeRamConfig(tmp, 'verbose-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'verbose-ws']) as {
      id: string
    }
    expect(created.id).toBe('verbose-ws')

    const plain = runCli(env, ['workspace', 'get', 'verbose-ws']) as {
      internals: unknown
      mounts: unknown[]
      sessions: unknown[]
    }
    expect(plain.mounts).toHaveLength(1)
    expect(plain.sessions).toHaveLength(1)
    expect(plain.internals).toBeNull()

    const verbose = runCli(env, ['workspace', 'get', 'verbose-ws', '--verbose']) as {
      internals: { cacheBytes: number; cacheEntries: number; historyLength: number }
    }
    expect(verbose.internals.cacheBytes).toBeGreaterThanOrEqual(0)
    expect(verbose.internals.cacheEntries).toBeGreaterThanOrEqual(0)
    expect(verbose.internals.historyLength).toBeGreaterThanOrEqual(0)

    runCli(env, ['workspace', 'delete', 'verbose-ws'])
  }, 30000)

  it('unknown workspace exits nonzero', () => {
    const missing = runCliRaw(env, ['workspace', 'get', 'does-not-exist'])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('daemon error 404')
  }, 30000)

  it('workspace config interpolation uses CLI environment', () => {
    const cfgPath = join(tmp, 'env-cfg.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: ${MIRAGE_E2E_MODE}\n')
    const useEnv = { ...env, MIRAGE_E2E_MODE: 'write' }

    const created = runCli(useEnv, ['workspace', 'create', cfgPath, '--id', 'env-ws']) as {
      id: string
    }
    expect(created.id).toBe('env-ws')

    const got = runCli(useEnv, ['workspace', 'get', 'env-ws']) as {
      mounts: { mode: string }[]
    }
    expect(got.mounts[0]?.mode).toBe('write')

    runCli(useEnv, ['workspace', 'delete', 'env-ws'])
  }, 30000)

  it('daemon status reports the running daemon', () => {
    const status = runCli(env, ['daemon', 'status']) as {
      running: boolean
      url: string
      workspaces: number
    }
    expect(status.running).toBe(true)
    expect(status.url).toBe(env.MIRAGE_DAEMON_URL)
    expect(status.workspaces).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('daemon stop makes status fail on an isolated port', () => {
    const stopEnv = cliEnv(ISOLATED_PORT)
    const cfgPath = writeRamConfig(tmp, 'daemon-stop-cfg.yaml')
    const created = runCli(stopEnv, ['workspace', 'create', cfgPath, '--id', 'daemon-stop-ws']) as {
      id: string
    }
    expect(created.id).toBe('daemon-stop-ws')

    const running = runCli(stopEnv, ['daemon', 'status']) as {
      running: boolean
      url: string
    }
    expect(running.running).toBe(true)
    expect(running.url).toBe(stopEnv.MIRAGE_DAEMON_URL)

    const stopped = runCli(stopEnv, ['daemon', 'stop']) as { stopped: boolean }
    expect(stopped.stopped).toBe(true)

    const status = runCliRaw(stopEnv, ['daemon', 'status'])
    expect(status.status).toBe(1)
    expect((status.parsed as { running: boolean }).running).toBe(false)
  }, 30000)

  it('provision returns a dry-run result', () => {
    const cfgPath = writeRamConfig(tmp, 'provision-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'provision-ws']) as {
      id: string
    }
    expect(created.id).toBe('provision-ws')

    const result = runCli(env, ['provision', '-w', 'provision-ws', '-c', 'echo planned']) as {
      kind: string
    }
    expect(result.kind).toBe('provision')

    runCli(env, ['workspace', 'delete', 'provision-ws'])
  }, 30000)

  it('subshell cwd changes do not leak', () => {
    const cfgPath = writeRamConfig(tmp, 'cwd-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'cwd-ws']) as {
      id: string
    }
    expect(created.id).toBe('cwd-ws')

    runCli(env, ['execute', '-w', 'cwd-ws', '-c', 'mkdir /sub'])
    const inner = runCli(env, ['execute', '-w', 'cwd-ws', '-c', '(cd /sub && pwd)']) as {
      stdout: string
    }
    expect(inner.stdout.trim()).toBe('/sub')

    const outer = runCli(env, ['execute', '-w', 'cwd-ws', '-c', 'pwd']) as { stdout: string }
    expect(outer.stdout.trim()).toBe('/')

    runCli(env, ['workspace', 'delete', 'cwd-ws'])
  }, 30000)

  it('subshell env changes do not leak', () => {
    const cfgPath = writeRamConfig(tmp, 'env-prefix-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'env-prefix-ws']) as {
      id: string
    }
    expect(created.id).toBe('env-prefix-ws')

    const inner = runCli(env, [
      'execute',
      '-w',
      'env-prefix-ws',
      '-c',
      '(export FOO=bar; printenv FOO)',
    ]) as { stdout: string }
    expect(inner.stdout.trim()).toBe('bar')

    const outer = runCli(env, [
      'execute',
      '-w',
      'env-prefix-ws',
      '-c',
      'printenv FOO || echo absent',
    ]) as { stdout: string }
    expect(outer.stdout.trim()).toBe('absent')

    runCli(env, ['workspace', 'delete', 'env-prefix-ws'])
  }, 30000)

  it('background jobs can be canceled', () => {
    const cfgPath = writeRamConfig(tmp, 'cancel-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'cancel-ws']) as {
      id: string
    }
    expect(created.id).toBe('cancel-ws')

    const submitted = runCli(env, ['execute', '-w', 'cancel-ws', '--bg', '-c', 'sleep 30']) as {
      jobId: string
    }
    expect(submitted.jobId).toMatch(/^job_/)

    const canceled = runCli(env, ['job', 'cancel', submitted.jobId]) as {
      jobId: string
      canceled: boolean
    }
    expect(canceled.jobId).toBe(submitted.jobId)
    expect(canceled.canceled).toBe(true)

    const waited = runCliRaw(env, ['job', 'wait', submitted.jobId])
    expect(waited.status).toBe(2)
    expect((waited.parsed as { status: string }).status).toBe('canceled')

    runCli(env, ['workspace', 'delete', 'cancel-ws'])
  }, 30000)

  it('missing config env vars fail before workspace creation', () => {
    const cfgPath = join(tmp, 'missing-env-cfg.yaml')
    writeFileSync(
      cfgPath,
      'mounts:\n  /:\n    resource: ram\n    mode: ${MIRAGE_E2E_MISSING_MODE}\n',
    )
    const useEnv = { ...env }
    delete useEnv.MIRAGE_E2E_MISSING_MODE

    const result = runCliRaw(useEnv, ['workspace', 'create', cfgPath, '--id', 'missing-env-ws'])
    expect(result.status).not.toBe(0)

    const listed = runCli(env, ['workspace', 'list']) as { id: string }[]
    expect(listed.some((w) => w.id === 'missing-env-ws')).toBe(false)
  }, 30000)

  it('workspace snapshot + load round-trips', () => {
    const cfgPath = writeRamConfig(tmp, 'round-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'round-ws']) as {
      id: string
    }
    expect(created.id).toBe('round-ws')

    const tarPath = join(tmp, 'round.tar')
    runCli(env, ['workspace', 'snapshot', 'round-ws', tarPath])
    expect(existsSync(tarPath)).toBe(true)

    runCli(env, ['workspace', 'delete', 'round-ws'])

    const loaded = runCli(env, ['workspace', 'load', tarPath, cfgPath, '--id', 'reloaded']) as {
      id: string
    }
    expect(loaded.id).toBe('reloaded')

    const listed = runCli(env, ['workspace', 'list']) as { id: string }[]
    expect(listed.some((w) => w.id === 'reloaded')).toBe(true)
  }, 30000)

  it('workspace clone round-trips', () => {
    const cfgPath = writeRamConfig(tmp, 'clone-cfg.yaml')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'clone-src']) as {
      id: string
    }
    expect(created.id).toBe('clone-src')

    runCli(env, ['execute', '-w', 'clone-src', '-c', 'echo source > /report.txt'])
    const cloned = runCli(env, ['workspace', 'clone', 'clone-src', '--id', 'clone-dst']) as {
      id: string
    }
    expect(cloned.id).toBe('clone-dst')

    const cloneRead = runCli(env, ['execute', '-w', 'clone-dst', '-c', 'cat /report.txt']) as {
      stdout: string
    }
    expect(cloneRead.stdout).toContain('source')

    runCli(env, ['execute', '-w', 'clone-dst', '-c', 'echo clone > /report.txt'])
    const originalRead = runCli(env, ['execute', '-w', 'clone-src', '-c', 'cat /report.txt']) as {
      stdout: string
    }
    expect(originalRead.stdout).toContain('source')

    runCli(env, ['workspace', 'delete', 'clone-src'])
    runCli(env, ['workspace', 'delete', 'clone-dst'])
  }, 30000)
})

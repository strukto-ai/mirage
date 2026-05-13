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

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.MIRAGE_DAEMON_URL = `http://127.0.0.1:${String(PORT)}`
  env.MIRAGE_IDLE_GRACE_SECONDS = '120'
  return env
}

function runCli(env: Record<string, string>, args: string[]): unknown {
  const r = spawnSync(process.execPath, [cliBin, ...args], {
    env,
    encoding: 'utf-8',
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

function runCliRaw(env: Record<string, string>, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [cliBin, ...args], {
    env,
    encoding: 'utf-8',
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
    try {
      spawnSync(process.execPath, [cliBin, 'daemon', 'stop'], {
        env,
        encoding: 'utf-8',
        timeout: 10000,
      })
    } catch {
      // teardown best-effort; test assertions already passed/failed
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  it('workspace lifecycle works end-to-end', () => {
    const cfgPath = join(tmp, 'config.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')

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

  it('execute propagates inner exit code to process exit', () => {
    const cfgPath = join(tmp, 'exit-cfg.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
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

  it('workspace snapshot + load round-trips', () => {
    const cfgPath = join(tmp, 'round-cfg.yaml')
    writeFileSync(cfgPath, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
    const created = runCli(env, ['workspace', 'create', cfgPath, '--id', 'round-ws']) as {
      id: string
    }
    expect(created.id).toBe('round-ws')

    const tarPath = join(tmp, 'round.tar')
    runCli(env, ['workspace', 'snapshot', 'round-ws', tarPath])
    expect(existsSync(tarPath)).toBe(true)

    runCli(env, ['workspace', 'delete', 'round-ws'])

    const loaded = runCli(env, ['workspace', 'load', tarPath, '--id', 'reloaded']) as {
      id: string
    }
    expect(loaded.id).toBe('reloaded')

    const listed = runCli(env, ['workspace', 'list']) as { id: string }[]
    expect(listed.some((w) => w.id === 'reloaded')).toBe(true)
  }, 30000)
})

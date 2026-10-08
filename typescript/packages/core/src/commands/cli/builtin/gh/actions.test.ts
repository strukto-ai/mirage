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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AccessorModule from './accessor.ts'
import { GitHubApiError, type GitHubTransport } from '../../../../core/github/client.ts'
import type { CommandFnResult } from '../../../config.ts'
import { PartialOutputError, UsageError } from '../../../errors.ts'
import type { CLIInvocation } from '../../types.ts'
import { crc32 } from '../../../../utils/compress.ts'
import { runViewCmd, workflowViewCmd } from './actions.ts'
import { cliInvocation } from '../../../../workspace/fixtures/cli_invocation.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Each `METHOD path` answers its own reply, or fails with it when it is an
// error; every call is recorded with its query.
const ROUTES = new Map<string, unknown>()
const CALLS: string[] = []

class RouteTransport implements GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.request('GET', path, undefined, params)
  }

  request(
    method: string,
    path: string,
    _body?: unknown,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const query = params === undefined ? '' : `?${new URLSearchParams(params).toString()}`
    CALLS.push(`${method} ${path}${query}`)
    const reply = ROUTES.get(`${method} ${path}`)
    if (reply instanceof Error) return Promise.reject(reply)
    if (reply === undefined) return Promise.reject(new GitHubApiError('Not Found', 404))
    return Promise.resolve(reply)
  }
}

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => new RouteTransport() }
})

function inv(texts: string[], flags: CLIInvocation['flags'] = {}): CLIInvocation {
  return cliInvocation({ config: { token: 't', repo: 'o/r' }, texts, flags })
}

function text(result: CommandFnResult): string {
  if (result === null) throw new Error('expected a result tuple')
  return DEC.decode(result[0] as Uint8Array)
}

// A zip holding `entries` uncompressed, the shape of GitHub's log archive.
function storedZip(entries: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of entries) {
    const path = ENC.encode(name)
    const data = ENC.encode(content)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint32(14, crc32(data), true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, path.length, true)
    const head = new DataView(new ArrayBuffer(46))
    head.setUint32(0, 0x02014b50, true)
    head.setUint16(4, 20, true)
    head.setUint16(6, 20, true)
    head.setUint32(16, crc32(data), true)
    head.setUint32(20, data.length, true)
    head.setUint32(24, data.length, true)
    head.setUint16(28, path.length, true)
    head.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), path, data)
    central.push(new Uint8Array(head.buffer), path)
    offset += 30 + path.length + data.length
  }
  const size = central.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function step(number: number, name: string, conclusion = 'success'): Record<string, unknown> {
  return { number, name, status: 'completed', conclusion }
}

const RUN = '/repos/o/r/actions/runs/7'

beforeEach(() => {
  ROUTES.clear()
  CALLS.length = 0
  ROUTES.set(`GET ${RUN}`, { id: 7, status: 'completed', conclusion: 'failure', name: 'CI' })
})

describe('gh run view --log', () => {
  it('prints each line behind its job and step, in step order', async () => {
    ROUTES.set(`GET ${RUN}/jobs`, {
      jobs: [
        {
          id: 1,
          name: 'build / test: unit',
          conclusion: 'failure',
          steps: [step(2, 'Run tests', 'failure'), step(1, 'Set up job')],
        },
      ],
    })
    ROUTES.set(
      `GET ${RUN}/logs`,
      storedZip([
        ['0_build  test unit.txt', 'whole job\n'],
        ['build  test unit/1_Set up job.txt', 'ready\r\n'],
        ['build  test unit/2_Run tests.txt', 'one\n\ntwo'],
      ]),
    )
    expect(text(await runViewCmd(inv(['7'], { log: true })))).toBe(
      'build / test: unit\tSet up job\tready\n' +
        'build / test: unit\tRun tests\tone\n' +
        'build / test: unit\tRun tests\t\n' +
        'build / test: unit\tRun tests\ttwo\n',
    )
    expect(CALLS).toEqual([`GET ${RUN}`, `GET ${RUN}/jobs?per_page=100&page=1`, `GET ${RUN}/logs`])
  })

  it('keeps only failed jobs and their failed steps under --log-failed', async () => {
    ROUTES.set(`GET ${RUN}/jobs`, {
      jobs: [
        { id: 1, name: 'lint', conclusion: 'success', steps: [step(1, 'Lint')] },
        {
          id: 2,
          name: 'test',
          conclusion: 'failure',
          steps: [step(1, 'Set up job'), step(2, 'Run tests', 'failure')],
        },
      ],
    })
    ROUTES.set(
      `GET ${RUN}/logs`,
      storedZip([
        ['lint/1_Lint.txt', 'clean\n'],
        ['test/1_Set up job.txt', 'ready\n'],
        ['test/2_Run tests.txt', 'boom\n'],
      ]),
    )
    expect(text(await runViewCmd(inv(['7'], { log_failed: true })))).toBe('test\tRun tests\tboom\n')
  })

  it("reads a job's whole log when the archive has no step of it", async () => {
    ROUTES.set(`GET ${RUN}/jobs`, {
      jobs: [
        { id: 1, name: 'test', conclusion: 'success', steps: [step(1, 'Run')] },
        { id: 2, name: 'skipped', conclusion: 'skipped', steps: [] },
      ],
    })
    ROUTES.set(`GET ${RUN}/logs`, storedZip([['-2147483648_test.txt', 'legacy\n']]))
    expect(text(await runViewCmd(inv(['7'], { log: true })))).toBe('test\tUNKNOWN STEP\tlegacy\n')
  })

  it('fetches a job the archive lacks on its own, and names one that has no log', async () => {
    ROUTES.set(`GET ${RUN}/jobs`, {
      jobs: [
        { id: 1, name: 'a', conclusion: 'success', steps: [] },
        { id: 2, name: 'b', conclusion: 'success', steps: [] },
      ],
    })
    ROUTES.set(`GET ${RUN}/logs`, storedZip([]))
    ROUTES.set('GET /repos/o/r/actions/jobs/1/logs', 'from the api\n')
    const failure = runViewCmd(inv(['7'], { log: true }))
    await expect(failure).rejects.toThrow(PartialOutputError)
    await expect(failure).rejects.toMatchObject({
      message: 'log not found: 2',
      stdout: ENC.encode('a\tUNKNOWN STEP\tfrom the api\n'),
    })
  })

  it('refuses a run still going before it asks for any log', async () => {
    ROUTES.set(`GET ${RUN}`, { id: 7, status: 'queued', conclusion: null })
    ROUTES.set(`GET ${RUN}/jobs`, { jobs: [] })
    await expect(runViewCmd(inv(['7'], { log: true }))).rejects.toThrow(
      'run 7 is still in progress; logs will be available when it is complete',
    )
    expect(CALLS).not.toContain(`GET ${RUN}/logs`)
  })

  it('names a run whose archive is missing or is no zip', async () => {
    ROUTES.set(`GET ${RUN}/jobs`, { jobs: [] })
    await expect(runViewCmd(inv(['7'], { log: true }))).rejects.toThrow(
      'failed to get run log: log not found',
    )
    ROUTES.set(`GET ${RUN}/logs`, ENC.encode('not a zip'))
    await expect(runViewCmd(inv(['7'], { log: true }))).rejects.toThrow(
      'failed to get run log: zip: not a valid zip file',
    )
  })

  it('takes one of --log and --log-failed, and answers --json first', async () => {
    await expect(runViewCmd(inv(['7'], { log: true, log_failed: true }))).rejects.toThrow(
      UsageError,
    )
    expect(CALLS).toEqual([])
    const out = text(await runViewCmd(inv(['7'], { log: true, json: 'status' })))
    expect(out).toBe('{"status":"completed"}\n')
  })
})

describe('gh workflow view --yaml', () => {
  const WORKFLOW = { id: 3, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }

  it('prints the file at the ref, adding the newline it lacks', async () => {
    ROUTES.set('GET /repos/o/r/actions/workflows/ci.yml', WORKFLOW)
    ROUTES.set('GET /repos/o/r/contents/.github/workflows/ci.yml', {
      content: 'bmFtZTogQ0kKb246IHB1c2g=\n',
    })
    expect(text(await workflowViewCmd(inv(['ci.yml'], { yaml: true, ref: 'dev' })))).toBe(
      'name: CI\non: push\n',
    )
    expect(CALLS).toEqual([
      'GET /repos/o/r/actions/workflows/ci.yml',
      'GET /repos/o/r/contents/.github/workflows/ci.yml?ref=dev',
    ])
  })

  it('refuses --ref without --yaml before asking anything', async () => {
    await expect(workflowViewCmd(inv(['ci.yml'], { ref: 'dev' }))).rejects.toThrow(
      '`--yaml` required when specifying `--ref`',
    )
    expect(CALLS).toEqual([])
  })

  it.each([
    [{}, 'could not find workflow file ci.yml, try specifying a branch or tag using `--ref`'],
    [{ ref: 'dev' }, 'could not find workflow file ci.yml on dev, try specifying a different ref'],
  ])('names a file the ref lacks as gh does (%o)', async (flags, message) => {
    ROUTES.set('GET /repos/o/r/actions/workflows/ci.yml', WORKFLOW)
    await expect(workflowViewCmd(inv(['ci.yml'], { yaml: true, ...flags }))).rejects.toThrow(
      message,
    )
  })
})

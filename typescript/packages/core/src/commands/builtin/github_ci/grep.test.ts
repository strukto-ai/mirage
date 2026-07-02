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

import { mountKey } from '../../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/github_ci/read.ts', () => {
  const read = vi.fn()
  async function* stream(...args: unknown[]) {
    yield await (read as (...a: unknown[]) => Promise<Uint8Array>)(...args)
  }
  return { read, stream }
})
vi.mock('../../../core/github_ci/readdir.ts', () => ({ readdir: vi.fn() }))
vi.mock('../../../core/github_ci/stat.ts', () => ({ stat: vi.fn() }))

import { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import type { CITransport } from '../../../core/github_ci/_client.ts'
import * as readModule from '../../../core/github_ci/read.ts'
import * as readdirModule from '../../../core/github_ci/readdir.ts'
import * as statModule from '../../../core/github_ci/stat.ts'
import { materialize } from '../../../io/types.ts'
import { type FileStat, FileType, PathSpec } from '../../../types.ts'
import { GITHUB_CI_GREP } from './grep.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class StubTransport implements CITransport {
  get(): Promise<unknown> {
    return Promise.resolve(null)
  }
  getBytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array())
  }
  getPaginated(): Promise<unknown[]> {
    return Promise.resolve([])
  }
}

function makeAccessor(): GitHubCIAccessor {
  return new GitHubCIAccessor({ transport: new StubTransport(), owner: 'o', repo: 'r' })
}

async function runGrep(
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ stdout: string; exitCode: number }> {
  const cmd = GITHUB_CI_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const result = await cmd.fn(makeAccessor(), paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'github_ci' } as never,
  })
  if (result === null) return { stdout: '', exitCode: 0 }
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { stdout: DEC.decode(buf), exitCode: io.exitCode }
}

function path(p: string): PathSpec {
  return new PathSpec({ virtual: p, directory: p, resolved: true, resourcePath: mountKey(p, '') })
}

describe('github_ci grep', () => {
  beforeEach(() => {
    vi.mocked(readModule.read).mockReset()
    vi.mocked(readdirModule.readdir).mockReset()
    vi.mocked(statModule.stat).mockReset()
  })

  it('matches lines in a file', async () => {
    vi.mocked(statModule.stat).mockResolvedValue({
      name: 'run.json',
      type: FileType.JSON,
    } as FileStat)
    vi.mocked(readModule.read).mockResolvedValue(ENC.encode('hello world\nbye world\n'))
    const { stdout, exitCode } = await runGrep([path('/runs/wf_1/run.json')], ['hello'])
    expect(stdout).toContain('hello world')
    expect(exitCode).toBe(0)
  })

  it('returns exit 1 when no match', async () => {
    vi.mocked(statModule.stat).mockResolvedValue({
      name: 'run.json',
      type: FileType.JSON,
    } as FileStat)
    vi.mocked(readModule.read).mockResolvedValue(ENC.encode('abc\ndef\n'))
    const { exitCode } = await runGrep([path('/runs/wf_1/run.json')], ['missing'])
    expect(exitCode).toBe(1)
  })

  it('recursively scans a directory with -r', async () => {
    vi.mocked(statModule.stat).mockImplementation((_a, p) => {
      if (p.virtual.endsWith('.json')) {
        return Promise.resolve({ name: 'wf.json', type: FileType.JSON } as FileStat)
      }
      return Promise.resolve({ name: 'workflows', type: FileType.DIRECTORY } as FileStat)
    })
    vi.mocked(readdirModule.readdir).mockImplementation((_a, p) => {
      if (p.virtual === '/workflows') {
        return Promise.resolve(['/workflows/ci_1.json', '/workflows/build_2.json'])
      }
      return Promise.resolve([])
    })
    vi.mocked(readModule.read).mockImplementation((_a, p) => {
      if (p.virtual.includes('ci_1')) return Promise.resolve(ENC.encode('name: Test\non: push\n'))
      return Promise.resolve(ENC.encode('name: Build\non: push\n'))
    })
    const { stdout, exitCode } = await runGrep([path('/workflows')], ['Test'], { r: true })
    expect(stdout).toContain('/workflows/ci_1.json')
    expect(stdout).not.toContain('/workflows/build_2.json')
    expect(exitCode).toBe(0)
  })
})

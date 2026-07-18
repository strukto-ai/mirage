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

vi.mock('../../../core/github_ci/readdir.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readdir: vi.fn(),
  isDirName: (child: string) => {
    const name = child.split('/').pop() ?? ''
    return !(
      name.endsWith('.json') ||
      name.endsWith('.jsonl') ||
      name.endsWith('.log') ||
      name.endsWith('.zip')
    )
  },
}))
vi.mock('../../../core/github_ci/stat.ts', () => ({ stat: vi.fn() }))

import { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import type { CITransport } from '../../../core/github_ci/_client.ts'
import * as readdirModule from '../../../core/github_ci/readdir.ts'
import * as statModule from '../../../core/github_ci/stat.ts'
import { materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { GITHUB_CI_FIND } from './find.ts'

const DEC = new TextDecoder()

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

function scope(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resolved: false,
    resourcePath: mountKey(virtual, ''),
  })
}

function fakeReaddir(_acc: unknown, p: PathSpec): Promise<string[]> {
  if (p.virtual === '/runs/wf_1') {
    return Promise.resolve(['/runs/wf_1/run.json', '/runs/wf_1/jobs'])
  }
  if (p.virtual === '/runs/wf_1/jobs') {
    return Promise.resolve(['/runs/wf_1/jobs/build_1.log'])
  }
  return Promise.resolve([])
}

function fakeStat(_acc: unknown, p: PathSpec | string): FileStat {
  const virtual = p instanceof PathSpec ? p.virtual : p
  const name = virtual.split('/').pop() ?? ''
  if (name.includes('.')) {
    return new FileStat({ name, type: FileType.TEXT, size: null })
  }
  return new FileStat({ name, type: FileType.DIRECTORY })
}

async function runFind(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string> {
  const cmd = GITHUB_CI_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
  const result = await cmd.fn(makeAccessor(), paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'github_ci' } as never,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('github_ci find', () => {
  beforeEach(() => {
    vi.mocked(readdirModule.readdir).mockImplementation(fakeReaddir as never)
    vi.mocked(statModule.stat).mockImplementation(((_acc: unknown, p: PathSpec | string) =>
      Promise.resolve(fakeStat(_acc, p))) as never)
  })

  it('refuses recursive search across runs', async () => {
    await expect(runFind([scope('/runs')], { name: '*.log' })).rejects.toThrow(
      'across runs is disabled',
    )
  })

  it('walks a single run and honors -name', async () => {
    const out = await runFind([scope('/runs/wf_1')], { name: '*.log' })
    expect(out.split('\n').filter((s) => s !== '')).toEqual(['/runs/wf_1/jobs/build_1.log'])
  })

  it('honors -path', async () => {
    const out = await runFind([scope('/runs/wf_1')], { path: '*jobs*' })
    expect(out.split('\n').filter((s) => s !== '')).toEqual([
      '/runs/wf_1/jobs',
      '/runs/wf_1/jobs/build_1.log',
    ])
  })

  it('counts sizeless entries as size 0 for -size', async () => {
    const out = await runFind([scope('/runs/wf_1')], { size: '+0c' })
    expect(out.split('\n').filter((s) => s !== '')).toEqual([])
  })
})

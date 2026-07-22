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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core'
import { installFakeNavigator, makeMockRoot } from '../../../test-utils.ts'
import { OPFSResource } from '../../../resource/opfs/opfs.ts'
import { Workspace } from '../../../workspace.ts'

let ws: Workspace
let restoreNav: () => void
const DEC = new TextDecoder()

async function run(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await ws.execute(cmd)
  return {
    stdout: DEC.decode(r.stdout),
    stderr: DEC.decode(r.stderr),
    exitCode: r.exitCode,
  }
}

beforeEach(async () => {
  restoreNav = installFakeNavigator(() => makeMockRoot())
  ws = new Workspace({ '/data': new OPFSResource() }, { mode: MountMode.WRITE })
  await ws.fs.writeFile('/data/hello.txt', 'hello from opfs\n')
  await ws.fs.writeFile('/data/q1.csv', 'revenue,100\nexpense,80\nprofit,20\n')
  await ws.fs.mkdir('/data/sub')
  await ws.fs.writeFile('/data/sub/nested.txt', 'line1\nline2\nline3\n')
})

afterEach(async () => {
  await ws.close()
  restoreNav()
})

describe('OPFS commands — readers', () => {
  it('ls lists entries', async () => {
    const r = await run('ls /data/')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello.txt')
    expect(r.stdout).toContain('q1.csv')
    expect(r.stdout).toContain('sub')
  })

  it('cat reads a file', async () => {
    const r = await run('cat /data/hello.txt')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello from opfs\n')
  })

  it('cat -n numbers lines', async () => {
    const r = await run('cat -n /data/sub/nested.txt')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('1\tline1')
    expect(r.stdout).toContain('2\tline2')
    expect(r.stdout).toContain('3\tline3')
  })

  it('head -n 2 takes first lines', async () => {
    const r = await run('head -n 2 /data/q1.csv')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('revenue,100\nexpense,80\n')
  })

  it('tail -n 1 takes last line', async () => {
    const r = await run('tail -n 1 /data/q1.csv')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('profit,20')
  })

  it('grep finds matches', async () => {
    const r = await run('grep revenue /data/q1.csv')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('revenue,100')
  })

  it('wc counts lines', async () => {
    const r = await run('wc -l /data/sub/nested.txt')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/3/)
  })

  it('stat returns metadata', async () => {
    const r = await run('stat /data/hello.txt')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello.txt')
  })

  it('sort orders lines', async () => {
    const r = await run('sort /data/q1.csv')
    expect(r.exitCode).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe('expense,80')
    expect(lines[1]).toBe('profit,20')
    expect(lines[2]).toBe('revenue,100')
  })

  it('tree walks subdirs', async () => {
    const r = await run('tree /data/')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello.txt')
    expect(r.stdout).toContain('sub')
    expect(r.stdout).toContain('nested.txt')
  })
})

describe('OPFS commands — writers', () => {
  it('sort -o writes sorted output', async () => {
    const r = await run('sort -o /data/sorted.csv /data/q1.csv')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    const output = DEC.decode(await ws.fs.readFile('/data/sorted.csv'))
    expect(output).toBe('expense,80\nprofit,20\nrevenue,100\n')
  })

  it('uniq writes output to a second path', async () => {
    await ws.fs.writeFile('/data/repeated.txt', 'alpha\nalpha\nbeta\nbeta\n')
    const r = await run('uniq /data/repeated.txt /data/unique.txt')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    const output = DEC.decode(await ws.fs.readFile('/data/unique.txt'))
    expect(output).toBe('alpha\nbeta\n')
  })

  it('tee -a appends to a file', async () => {
    const r = await run("echo 'appended' | tee -a /data/hello.txt")
    expect(r.exitCode).toBe(0)
    const after = DEC.decode(await ws.fs.readFile('/data/hello.txt'))
    expect(after).toBe('hello from opfs\nappended\n')
  })
})

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

import { describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { MountMode } from '../types.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

// A read-family command with one good and one missing operand keeps the
// good operand's output, reports each missing operand on stderr, and exits
// 1, per GNU coreutils. Single-mount and cross-mount must be byte-identical.
async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const a = new RAMResource()
  const b = new RAMResource()
  ops.registerResource(a)
  ops.registerResource(b)
  const ws = new Workspace(
    { '/a': a, '/b': b },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
  await ws.execute('echo aaa > /a/f.txt')
  return ws
}

async function run(cmd: string): Promise<[string, string, number]> {
  const ws = await makeWs()
  try {
    const result = await ws.execute(cmd)
    return [result.stdoutText, result.stderrText, result.exitCode]
  } finally {
    await ws.close()
  }
}

describe('single-mount partial output on missing operands', () => {
  it('cat good then missing keeps partial output', async () => {
    const [out, err, code] = await run('cat /a/f.txt /a/missing.txt')
    expect(out).toBe('aaa\n')
    expect(err).toBe('cat: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('cat missing then good keeps partial output', async () => {
    const [out, err, code] = await run('cat /a/missing.txt /a/f.txt')
    expect(out).toBe('aaa\n')
    expect(err).toBe('cat: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('cat all missing reports each operand', async () => {
    const [out, err, code] = await run('cat /a/m1.txt /a/m2.txt')
    expect(out).toBe('')
    expect(err).toBe(
      'cat: /a/m1.txt: No such file or directory\n' + 'cat: /a/m2.txt: No such file or directory\n',
    )
    expect(code).toBe(1)
  })

  it('wc good then missing keeps total', async () => {
    const [out, err, code] = await run('wc -l /a/f.txt /a/missing.txt')
    expect(out).toBe('1 /a/f.txt\n1 total\n')
    expect(err).toBe('wc: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('wc all missing prints zero total', async () => {
    const [out, err, code] = await run('wc -l /a/m1.txt /a/m2.txt')
    expect(out).toBe('0 total\n')
    expect(err).toBe(
      'wc: /a/m1.txt: No such file or directory\n' + 'wc: /a/m2.txt: No such file or directory\n',
    )
    expect(code).toBe(1)
  })

  it('head good then missing keeps banner and content', async () => {
    const [out, err, code] = await run('head -n 1 /a/f.txt /a/missing.txt')
    expect(out).toBe('==> /a/f.txt <==\naaa\n')
    expect(err).toBe('head: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('head missing first has no leading blank line', async () => {
    const [out, err, code] = await run('head -n 1 /a/missing.txt /a/f.txt')
    expect(out).toBe('==> /a/f.txt <==\naaa\n')
    expect(err).toBe('head: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('tail good then missing keeps banner and content', async () => {
    const [out, err, code] = await run('tail -n 1 /a/f.txt /a/missing.txt')
    expect(out).toBe('==> /a/f.txt <==\naaa\n')
    expect(err).toBe('tail: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('single missing operand unchanged', async () => {
    const [out, err, code] = await run('cat /a/missing.txt')
    expect(out).toBe('')
    expect(err).toBe('cat: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })
})

describe('cross-mount partial output matches single-mount bytes', () => {
  it('cat good then missing keeps partial output', async () => {
    const [out, err, code] = await run('cat /a/f.txt /b/missing.txt')
    expect(out).toBe('aaa\n')
    expect(err).toBe('cat: /b/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('wc good then missing keeps total', async () => {
    const [out, err, code] = await run('wc -l /a/f.txt /b/missing.txt')
    expect(out).toBe('1 /a/f.txt\n1 total\n')
    expect(err).toBe('wc: /b/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('head good then missing keeps banner and content', async () => {
    const [out, err, code] = await run('head -n 1 /a/f.txt /b/missing.txt')
    expect(out).toBe('==> /a/f.txt <==\naaa\n')
    expect(err).toBe('head: /b/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('tail good then missing keeps banner and content', async () => {
    const [out, err, code] = await run('tail -n 1 /a/f.txt /b/missing.txt')
    expect(out).toBe('==> /a/f.txt <==\naaa\n')
    expect(err).toBe('tail: /b/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })
})

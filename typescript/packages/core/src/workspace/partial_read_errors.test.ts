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
  it('sed keeps partial output across mounts', async () => {
    const ws = await makeWs()
    try {
      await ws.execute("printf '1\\n2\\n' > /a/n.txt")
      const result = await ws.execute('sed s/1/X/ /a/n.txt /b/missing.txt')
      expect(result.stdoutText).toBe('X\n2\n')
      expect(result.stderrText).toBe('sed: /b/missing.txt: No such file or directory\n')
      expect(result.exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('sort aborts across mounts like single-mount', async () => {
    const ws = await makeWs()
    try {
      const result = await ws.execute('sort /a/f.txt /b/missing.txt')
      expect(result.stdoutText).toBe('')
      expect(result.stderrText).toBe('sort: /b/missing.txt: No such file or directory\n')
      expect(result.exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('nl reports its own name through the stream strategy', async () => {
    const ws = await makeWs()
    try {
      await ws.execute("printf '1\\n2\\n' > /a/n.txt")
      const result = await ws.execute('nl /a/n.txt /b/missing.txt')
      expect(result.stdoutText).toBe('     1\t1\n     2\t2\n')
      expect(result.stderrText).toBe('nl: /b/missing.txt: No such file or directory\n')
      expect(result.exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('md5 keeps partial output across mounts', async () => {
    const ws = await makeWs()
    try {
      await ws.execute("printf '1\\n2\\n' > /a/n.txt")
      const result = await ws.execute('md5 /a/n.txt /b/missing.txt')
      expect(result.stdoutText).toBe('6ddb4095eb719e2a9f0a3f95677d24e0  /a/n.txt\n')
      expect(result.stderrText).toBe('md5: /b/missing.txt: No such file or directory\n')
      expect(result.exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

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

async function makeNumberedWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const a = new RAMResource()
  ops.registerResource(a)
  const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, ops, shellParser: parser })
  await ws.execute("printf '1\\n2\\n' > /a/f.txt && printf '3\\n4\\n' > /a/g.txt")
  await ws.execute("printf 'hello\\n' > /a/h.txt")
  return ws
}

async function runNumbered(cmds: string[]): Promise<[string, string, number]> {
  const ws = await makeNumberedWs()
  try {
    let result = await ws.execute(cmds[0] ?? '')
    for (const cmd of cmds.slice(1)) result = await ws.execute(cmd)
    return [result.stdoutText, result.stderrText, result.exitCode]
  } finally {
    await ws.close()
  }
}

describe('every operand is processed, not just the first', () => {
  it('cut processes all operands', async () => {
    const [out, err, code] = await runNumbered(['cut -c1 /a/f.txt /a/g.txt'])
    expect(out).toBe('1\n2\n3\n4\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  it('tac reverses each operand independently', async () => {
    const [out, err, code] = await runNumbered(['tac /a/f.txt /a/g.txt'])
    expect(out).toBe('2\n1\n4\n3\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  it('nl numbering continues across operands', async () => {
    const [out, err, code] = await runNumbered(['nl /a/f.txt /a/g.txt'])
    expect(out).toBe('     1\t1\n     2\t2\n     3\t3\n     4\t4\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  it('strings scans all operands', async () => {
    const [out, err, code] = await runNumbered([
      "printf 'worlds\\n' > /a/h2.txt",
      'strings /a/h.txt /a/h2.txt',
    ])
    expect(out).toBe('hello\nworlds\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  it('zcat concatenates all operands', async () => {
    const [out, err, code] = await runNumbered([
      "printf 'z\\n' > /a/z1.txt && printf 'y\\n' > /a/z2.txt && gzip /a/z1.txt /a/z2.txt",
      'zcat /a/z1.txt.gz /a/z2.txt.gz',
    ])
    expect(out).toBe('z\ny\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })
})

describe('rest of the read family keeps partial output past missing', () => {
  const CASES: [string, string, string][] = [
    ['nl /a/f.txt /a/missing.txt', '     1\t1\n     2\t2\n', 'nl'],
    ['md5 /a/f.txt /a/missing.txt', '6ddb4095eb719e2a9f0a3f95677d24e0  /a/f.txt\n', 'md5'],
    [
      'sha256sum /a/f.txt /a/missing.txt',
      'a6e2b7a040683432de03a18fd8a1939a2fdf82585b364bfc874bdd4095c4cae1  /a/f.txt\n',
      'sha256sum',
    ],
    ['tac /a/f.txt /a/missing.txt', '2\n1\n', 'tac'],
    ['rev /a/f.txt /a/missing.txt', '1\n2\n', 'rev'],
    ['cut -c1 /a/f.txt /a/missing.txt', '1\n2\n', 'cut'],
    ['expand /a/f.txt /a/missing.txt', '1\n2\n', 'expand'],
    ['unexpand /a/f.txt /a/missing.txt', '1\n2\n', 'unexpand'],
    ['fold /a/f.txt /a/missing.txt', '1\n2\n', 'fold'],
    ['fmt /a/f.txt /a/missing.txt', '1 2\n', 'fmt'],
  ]
  for (const [cmd, expected, name] of CASES) {
    it(`${name} keeps partial output`, async () => {
      const [out, err, code] = await runNumbered([cmd])
      expect(out).toBe(expected)
      expect(err).toBe(`${name}: /a/missing.txt: No such file or directory\n`)
      expect(code).toBe(1)
    })
  }

  it('strings keeps partial output', async () => {
    const [out, err, code] = await runNumbered(['strings /a/h.txt /a/missing.txt'])
    expect(out).toBe('hello\n')
    expect(err).toBe('strings: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('zcat keeps partial output', async () => {
    const [out, err, code] = await runNumbered([
      "printf 'z\\n' > /a/z1.txt && gzip /a/z1.txt",
      'zcat /a/z1.txt.gz /a/missing.gz',
    ])
    expect(out).toBe('z\n')
    expect(err).toBe('zcat: /a/missing.gz: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('nl all missing reports each operand', async () => {
    const [out, err, code] = await runNumbered(['nl /a/m1.txt /a/m2.txt'])
    expect(out).toBe('')
    expect(err).toBe(
      'nl: /a/m1.txt: No such file or directory\n' + 'nl: /a/m2.txt: No such file or directory\n',
    )
    expect(code).toBe(1)
  })

  it('stat keeps the good row past missing', async () => {
    const [out, err, code] = await runNumbered(['stat /a/f.txt /a/missing.txt'])
    expect(out).toContain('name=f.txt')
    expect(err).toBe('stat: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('sed keeps partial output past missing', async () => {
    const [out, err, code] = await runNumbered(['sed s/1/X/ /a/f.txt /a/missing.txt'])
    expect(out).toBe('X\n2\n')
    expect(err).toBe('sed: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('sort still aborts on missing', async () => {
    const [out, err, code] = await runNumbered(['sort /a/f.txt /a/missing.txt'])
    expect(out).toBe('')
    expect(err).toBe('sort: /a/missing.txt: No such file or directory\n')
    expect(code).toBe(1)
  })
})

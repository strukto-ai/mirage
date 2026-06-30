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

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { applyStateDict, toStateDict } from './snapshot/state.ts'
import { type ExecuteResult, Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tempDir: string

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tempDir = mkdtempSync(join(tmpdir(), 'mirage-history-view-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function makeWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

function out(r: ExecuteResult): string {
  return r.stdoutText
}

async function commands(ws: Workspace): Promise<(string | undefined)[]> {
  return (await ws.history()).map((e) => e.command as string)
}

describe('history view + builtin', () => {
  it('history lists only the calling session', async () => {
    const ws = makeWs()
    ws.createSession('s2')
    await ws.execute('ls /data')
    await ws.execute('pwd')
    await ws.execute('ls /', { sessionId: 's2' })
    const mine = out(await ws.execute('history'))
    const other = out(await ws.execute('history', { sessionId: 's2' }))
    expect(mine).toContain('ls /data')
    expect(mine).toContain('pwd')
    expect(other).not.toContain('ls /data')
    expect(other).toContain('ls /')
    await ws.close()
  })

  it('cat /.bash_history shows all sessions in histfile format', async () => {
    const ws = makeWs()
    ws.createSession('s2')
    await ws.execute('ls /data')
    await ws.execute('pwd', { sessionId: 's2' })
    const res = await ws.execute('cat /.bash_history')
    expect(res.exitCode).toBe(0)
    expect(out(res)).toContain('ls /data')
    expect(out(res)).toContain('pwd')
    expect((out(res).match(/#/g) ?? []).length).toBeGreaterThanOrEqual(2)
    await ws.close()
  })

  it('grep and tail work over /.bash_history', async () => {
    const ws = makeWs()
    await ws.execute('ls /data')
    await ws.execute('pwd')
    const grep = await ws.execute('grep pwd /.bash_history')
    expect(grep.exitCode).toBe(0)
    expect(out(grep)).toContain('pwd')
    expect(out(grep)).not.toContain('ls /data')
    const tail = await ws.execute('tail -n 2 /.bash_history')
    expect(tail.exitCode).toBe(0)
    expect(out(tail)).toContain('pwd')
    await ws.close()
  })

  it('ls / hides the dotfile, ls -a shows it', async () => {
    const ws = makeWs()
    expect(out(await ws.execute('ls /'))).not.toContain('.bash_history')
    expect(out(await ws.execute('ls -a /'))).toContain('.bash_history')
    await ws.close()
  })

  it('history -c clears only the calling session; file unchanged for others', async () => {
    const ws = makeWs()
    ws.createSession('s2')
    await ws.execute('ls /data')
    await ws.execute('pwd', { sessionId: 's2' })
    const clear = await ws.execute('history -c')
    expect(clear.exitCode).toBe(0)
    expect(out(await ws.execute('history'))).not.toContain('ls /data')
    expect(out(await ws.execute('history', { sessionId: 's2' }))).toContain('pwd')
    expect(out(await ws.execute('cat /.bash_history'))).toContain('ls /data')
    await ws.close()
  })

  it('appending to /.bash_history is rejected', async () => {
    const ws = makeWs()
    expect((await ws.execute('echo hacked >> /.bash_history')).exitCode).not.toBe(0)
    await ws.close()
  })

  it('/.sessions no longer resolves', async () => {
    const ws = makeWs()
    expect((await ws.execute('ls /.sessions')).exitCode).not.toBe(0)
    await ws.close()
  })

  it('unmounting the history view is rejected', async () => {
    const ws = makeWs()
    await expect(ws.unmount('/.bash_history')).rejects.toThrow(/history view/i)
    await ws.close()
  })

  it('ws.history() returns command events in order', async () => {
    const ws = makeWs()
    await ws.execute('ls /data')
    await ws.execute('pwd')
    const events = await ws.history()
    expect(events.map((e) => e.command)).toEqual(['ls /data', 'pwd'])
    expect(events.every((e) => e.type === 'command')).toBe(true)
    await ws.close()
  })
})

describe('history builtin flags', () => {
  it('-s appends without executing', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    const res = await ws.execute('history -s rm -rf /data')
    expect(res.exitCode).toBe(0)
    expect(out(await ws.execute('history'))).toContain('rm -rf /data')
    expect((await ws.execute('ls /data/x')).exitCode).not.toBe(0)
    await ws.close()
  })

  it('-d deletes and renumbers', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    await ws.execute('echo keep')
    expect((await ws.execute('history -d 1')).exitCode).toBe(0)
    expect(out(await ws.execute('history')).startsWith('1  echo keep')).toBe(true)
    await ws.close()
  })

  it('-d with an attached offset deletes', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    await ws.execute('echo keep')
    expect((await ws.execute('history -d1')).exitCode).toBe(0)
    expect(out(await ws.execute('history')).startsWith('1  echo keep')).toBe(true)
    await ws.close()
  })

  it('-d out of range exits 1', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    const res = await ws.execute('history -d 99')
    expect(res.exitCode).toBe(1)
    expect(res.stderrText).toContain('99: history position out of range')
    await ws.close()
  })

  it('-d non-numeric exits 1', async () => {
    const ws = makeWs()
    const res = await ws.execute('history -d abc')
    expect(res.exitCode).toBe(1)
    expect(res.stderrText).toContain('abc: history position out of range')
    await ws.close()
  })

  it('-d with trailing garbage is rejected (1abc, not parsed as 1)', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    const res = await ws.execute('history -d 1abc')
    expect(res.exitCode).toBe(1)
    expect(res.stderrText).toContain('1abc: history position out of range')
    await ws.close()
  })

  it('a count with trailing garbage is rejected (3abc, not parsed as 3)', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    const res = await ws.execute('history 3abc')
    expect(res.exitCode).toBe(1)
    expect(res.stderrText).toContain('3abc: numeric argument required')
    await ws.close()
  })

  it('-d negative offset deletes the last entry', async () => {
    const ws = makeWs()
    await ws.execute('echo first')
    await ws.execute('echo last')
    expect((await ws.execute('history -d -1')).exitCode).toBe(0)
    const listing = out(await ws.execute('history'))
    expect(listing).toContain('echo first')
    expect(listing.split('\n').filter((l) => l.includes('echo last'))).toEqual([])
    await ws.close()
  })

  it('-d requires an argument (usage, exit 2)', async () => {
    const ws = makeWs()
    const res = await ws.execute('history -d')
    expect(res.exitCode).toBe(2)
    expect(res.stderrText).toContain('-d: option requires an argument')
    expect(res.stderrText).toContain('history: usage:')
    await ws.close()
  })

  it('invalid option is a usage error (exit 2)', async () => {
    const ws = makeWs()
    const res = await ws.execute('history -z')
    expect(res.exitCode).toBe(2)
    expect(res.stderrText).toContain('-z: invalid option')
    expect(res.stderrText).toContain('history: usage:')
    await ws.close()
  })

  it('-p prints args without storing them as a command', async () => {
    const ws = makeWs()
    const res = await ws.execute('history -p hello world')
    expect(res.exitCode).toBe(0)
    expect(out(res)).toBe('hello\nworld\n')
    expect(out(await ws.execute('history'))).toContain('1  history -p hello world')
    await ws.close()
  })

  it('-ps suppresses the print', async () => {
    const ws = makeWs()
    const res = await ws.execute('history -ps echo hi')
    expect(res.exitCode).toBe(0)
    expect(out(res)).toBe('')
    expect(out(await ws.execute('history'))).toContain('echo hi')
    await ws.close()
  })

  it('history 0 lists nothing', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    await ws.execute('echo two')
    const res = await ws.execute('history 0')
    expect(res.exitCode).toBe(0)
    expect(out(res)).toBe('')
    await ws.close()
  })

  it('-a/-r/-w/-n are no-ops', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    for (const flag of ['-a', '-r', '-w', '-n']) {
      const res = await ws.execute(`history ${flag}`)
      expect(res.exitCode).toBe(0)
      expect(out(res)).toBe('')
    }
    await ws.close()
  })

  it('-cw clears and the listing is empty after', async () => {
    const ws = makeWs()
    await ws.execute('pwd')
    expect((await ws.execute('history -cw')).exitCode).toBe(0)
    expect(out(await ws.execute('history 1'))).not.toContain('pwd')
    await ws.close()
  })

  it('find resolves the single view entry via the generic', async () => {
    const ws = makeWs()
    expect(out(await ws.execute('find /.bash_history'))).toBe('/.bash_history\n')
    expect(out(await ws.execute("find /.bash_history -name '*.bash*'"))).toBe('/.bash_history\n')
    expect(out(await ws.execute('find /.bash_history -type d'))).toBe('')
    await ws.close()
  })
})

describe('history recording boundaries (GNU line-reader semantics)', () => {
  it('command substitution records only the outer line', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    await ws.execute("wc -l $(find /data -name '*.txt')")
    expect(await commands(ws)).toEqual([
      'echo hi > /data/f.txt',
      "wc -l $(find /data -name '*.txt')",
    ])
    await ws.close()
  })

  it('substitution keeps inner ops in the audit log', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    await ws.execute('echo $(cat /data/f.txt)')
    const reads = (await ws.observer.events()).filter((e) => e.type === 'op' && e.op === 'read')
    expect(reads.some((e) => String(e.path).endsWith('f.txt'))).toBe(true)
    await ws.close()
  })

  it('outer ops after a substitution are not lost', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    await ws.execute("wc -l $(find /data -name '*.txt')")
    const reads = (await ws.observer.events())
      .filter((e) => e.type === 'op')
      .map((e) => [e.op, e.path])
    expect(reads).toContainEqual(['read', '/data/f.txt'])
    await ws.close()
  })

  it('eval / xargs / source each record a single entry', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    await ws.execute('eval cat /data/f.txt')
    await ws.execute('echo /data/f.txt | xargs cat')
    await ws.execute("echo 'cat /data/f.txt' > /data/s.sh")
    await ws.execute('source /data/s.sh')
    expect(await commands(ws)).toEqual([
      'echo hi > /data/f.txt',
      'eval cat /data/f.txt',
      'echo /data/f.txt | xargs cat',
      "echo 'cat /data/f.txt' > /data/s.sh",
      'source /data/s.sh',
    ])
    await ws.close()
  })

  it('an unrecorded execute skips history but keeps its ops', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    await ws.execute('cat /data/f.txt', { record: false })
    expect(await commands(ws)).toEqual(['echo hi > /data/f.txt'])
    await ws.close()
  })

  it('a failed line still records its ops and a failed command entry', async () => {
    const ws = makeWs()
    await ws.execute('echo hi > /data/f.txt')
    const dispatcher = (ws as unknown as { dispatcher: { applyIo: unknown } }).dispatcher
    dispatcher.applyIo = () => {
      throw new Error('induced')
    }
    const res = await ws.execute('cat /data/f.txt')
    expect(res.exitCode).toBe(1)
    const events = await ws.observer.events()
    const reads = events.filter((e) => e.type === 'op' && e.op === 'read')
    expect(reads.some((e) => String(e.path).endsWith('f.txt'))).toBe(true)
    const lastCmd = events.filter((e) => e.type === 'command').at(-1)
    expect(lastCmd?.command).toBe('cat /data/f.txt')
    expect(lastCmd?.exit_code).toBe(1)
    await ws.close()
  })
})

describe('history snapshot rewind', () => {
  it('snapshot + load preserves clear tombstones', async () => {
    const ws = makeWs()
    await ws.execute('ls /data')
    await ws.execute('history -c')
    await ws.execute('pwd')
    const path = join(tempDir, 'tombstones.json')
    await ws.snapshot(path)
    const dst = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const mine = out(await dst.execute('history'))
    expect(mine).not.toContain('ls /data')
    expect(mine).toContain('pwd')
    expect(out(await dst.execute('cat /.bash_history'))).toContain('ls /data')
    await ws.close()
    await dst.close()
  })

  it('in-place restore rewinds the recorder to the snapshot timeline', async () => {
    const src = makeWs()
    await src.execute('echo from-snapshot')
    const state = await toStateDict(src)
    const dst = makeWs()
    await dst.execute('echo pre-restore')
    await applyStateDict(dst, state)
    expect(await commands(dst)).toEqual(['echo from-snapshot'])
    await src.close()
    await dst.close()
  })
})

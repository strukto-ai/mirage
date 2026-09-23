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

import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function p(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
}

function decode(bytes: Uint8Array): string {
  return DEC.decode(bytes)
}

async function buildWs(): Promise<Workspace> {
  const mem = new RAMVFS()
  await mem.writeFile(p('/hello.txt'), ENC.encode('hello world\n'))
  await mem.writeFile(p('/numbers.txt'), ENC.encode('3\n1\n2\n1\n3\n'))
  await mem.writeFile(
    p('/log.txt'),
    ENC.encode('INFO start\nERROR fail\nINFO ok\nERROR bad\nINFO done\n'),
  )
  await mem.mkdir(p('/subdir'))
  await mem.writeFile(p('/subdir/a.txt'), ENC.encode('aaa\n'))
  await mem.writeFile(p('/subdir/b.txt'), ENC.encode('bbb\n'))
  await mem.writeFile(p('/config.json'), ENC.encode('{"key": "value"}\n'))
  const big = Array.from({ length: 5000 }, (_, i) => `row ${i.toString()}`).join('\n') + '\n'
  await mem.writeFile(p('/big.txt'), ENC.encode(big))
  const ws = new Workspace({ '/data': mem }, { mode: MountMode.WRITE })
  ws.cwd = '/'
  return ws
}

describe('pipeline', () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = await buildWs()
  })

  afterEach(async () => {
    await ws.close()
  })

  // ── Pipes ─────────────────────────────────────────────────────────

  it('pipe grep sort uniq', async () => {
    const io = await ws.shell('cat /data/numbers.txt | sort | uniq')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines).toEqual(['1', '2', '3'])
  })

  it('pipe grep wc', async () => {
    const io = await ws.shell('grep ERROR /data/log.txt | wc -l')
    expect(decode(io.stdout).trim()).toBe('2')
  })

  it('pipe head stops early', async () => {
    const io = await ws.shell('cat /data/big.txt | head -n 3')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe('row 0')
  })

  it('pipe tail', async () => {
    const io = await ws.shell('cat /data/log.txt | tail -n 2')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[lines.length - 1]).toBe('INFO done')
  })

  it('triple pipe', async () => {
    const io = await ws.shell('cat /data/log.txt | grep INFO | head -n 2')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines.every((l) => l.includes('INFO'))).toBe(true)
  })

  // ── Control flow ─────────────────────────────────────────────────

  it('and success', async () => {
    const io = await ws.shell('cat /data/hello.txt && echo done')
    expect(decode(io.stdout)).toContain('done')
  })

  it('and failure short-circuits', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt && echo should_not_appear')
    expect(decode(io.stdout)).not.toContain('should_not_appear')
  })

  it('or fallback', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt || echo fallback')
    expect(decode(io.stdout)).toContain('fallback')
  })

  it('semicolon runs both', async () => {
    const io = await ws.shell('echo first ; echo second')
    expect(decode(io.stdout)).toContain('second')
  })

  // ── Redirects ────────────────────────────────────────────────────

  it('redirect stdout to file', async () => {
    await ws.shell('echo written > /data/out.txt')
    const io = await ws.shell('cat /data/out.txt')
    expect(decode(io.stdout)).toContain('written')
  })

  it('redirect append', async () => {
    await ws.shell('echo line1 > /data/append.txt')
    await ws.shell('echo line2 >> /data/append.txt')
    const io = await ws.shell('cat /data/append.txt')
    const out = decode(io.stdout)
    expect(out).toContain('line1')
    expect(out).toContain('line2')
  })

  it('redirect on or chain', async () => {
    const io = await ws.shell(
      'grep hello /data/hello.txt > /data/out.txt || ' +
        'echo fallback > /data/out.txt; ' +
        'cat /data/out.txt',
    )
    expect(decode(io.stdout)).toContain('hello')
  })

  it('redirect on and chain', async () => {
    const io = await ws.shell(
      'echo first > /data/chain.txt && ' +
        'echo second >> /data/chain.txt; ' +
        'cat /data/chain.txt',
    )
    const out = decode(io.stdout)
    expect(out).toContain('first')
    expect(out).toContain('second')
  })

  it('redirect stdin', async () => {
    const io = await ws.shell('grep world < /data/hello.txt')
    expect(decode(io.stdout)).toContain('world')
  })

  it('heredoc', async () => {
    const io = await ws.shell('cat << EOF\nhello heredoc\nEOF')
    expect(decode(io.stdout)).toContain('hello heredoc')
  })

  // ── Subshell isolation ───────────────────────────────────────────

  it('subshell cd isolated', async () => {
    await ws.shell('cd /data')
    await ws.shell('(cd /data/subdir)')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe('/data')
  })

  it('subshell export isolated', async () => {
    await ws.shell('(export LEAK=yes)')
    expect(Object.hasOwn(ws.getSession(ws.defaultSessionId).env, 'LEAK')).toBe(false)
  })

  it('subshell inherits parent env', async () => {
    await ws.shell('export INHERITED=true')
    const io = await ws.shell('(printenv INHERITED)')
    expect(decode(io.stdout)).toContain('true')
  })

  it('nested subshell export does not leak', async () => {
    await ws.shell('((export DEEP=yes))')
    expect(Object.hasOwn(ws.getSession(ws.defaultSessionId).env, 'DEEP')).toBe(false)
  })

  // ── Background jobs ──────────────────────────────────────────────

  it('background basic', async () => {
    await ws.shell('cat /data/hello.txt &')
    const io = await ws.shell('wait %1')
    expect(decode(io.stdout)).toContain('hello')
  })

  it('background isolation env', async () => {
    await ws.shell('export BG_VAR=leaked &')
    await ws.shell('wait %1')
    expect(Object.hasOwn(ws.getSession(ws.defaultSessionId).env, 'BG_VAR')).toBe(false)
  })

  it('background isolation cwd', async () => {
    await ws.shell('cd /data &')
    await ws.shell('wait %1')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe('/')
  })

  it('background sees parent env', async () => {
    await ws.shell('export VISIBLE=yes')
    await ws.shell('printenv VISIBLE &')
    const io = await ws.shell('wait %1')
    expect(decode(io.stdout)).toContain('yes')
  })

  // ── SessionState: cd + env ────────────────────────────────────────────

  it('cd then relative cat', async () => {
    await ws.shell('cd /data/subdir')
    const io = await ws.shell('cat a.txt')
    expect(decode(io.stdout)).toContain('aaa')
  })

  it('cd nested relative', async () => {
    await ws.shell('cd /data')
    await ws.shell('cd subdir')
    const io = await ws.shell('cat b.txt')
    expect(decode(io.stdout)).toContain('bbb')
  })

  it('export then variable expansion', async () => {
    await ws.shell('export PATTERN=ERROR')
    const io = await ws.shell('grep $PATTERN /data/log.txt | wc -l')
    expect(decode(io.stdout).trim()).toBe('2')
  })

  it('export unset cycle', async () => {
    await ws.shell('export TMP=val')
    expect(ws.getSession(ws.defaultSessionId).env.TMP).toBe('val')
    await ws.shell('unset TMP')
    expect(Object.hasOwn(ws.getSession(ws.defaultSessionId).env, 'TMP')).toBe(false)
  })

  it('printenv shows all', async () => {
    await ws.shell('export A=1')
    await ws.shell('export B=2')
    const io = await ws.shell('printenv')
    const out = decode(io.stdout)
    expect(out).toContain('A=1')
    expect(out).toContain('B=2')
  })

  it('printenv single key', async () => {
    await ws.shell('export SECRET=abc')
    const io = await ws.shell('printenv SECRET')
    expect(decode(io.stdout).trim()).toBe('abc')
  })

  it('printenv missing key', async () => {
    const io = await ws.shell('printenv NOSUCH')
    expect(io.exitCode).toBe(1)
  })

  // ── Multi-session isolation ──────────────────────────────────────

  it('two sessions isolated cwd', async () => {
    const sa = ws.createSession('s-a')
    sa.cwd = '/'
    const sb = ws.createSession('s-b')
    sb.cwd = '/'
    await ws.shell('cd /data', { sessionId: 's-a' })
    await ws.shell('cd /data/subdir', { sessionId: 's-b' })
    expect(ws.getSession('s-a').cwd).toBe('/data')
    expect(ws.getSession('s-b').cwd).toBe('/data/subdir')
  })
  it('two sessions isolated env', async () => {
    ws.createSession('s-a')
    ws.createSession('s-b')
    await ws.shell('export X=from_a', { sessionId: 's-a' })
    await ws.shell('export X=from_b', { sessionId: 's-b' })
    expect(ws.getSession('s-a').env.X).toBe('from_a')
    expect(ws.getSession('s-b').env.X).toBe('from_b')
  })
  it('session env not visible cross-session', async () => {
    ws.createSession('s-a')
    ws.createSession('s-b')
    await ws.shell('export PRIVATE=yes', { sessionId: 's-a' })
    const io = await ws.shell('printenv PRIVATE', { sessionId: 's-b' })
    expect(io.exitCode).toBe(1)
  })

  // ── For loops ────────────────────────────────────────────────────

  it('for loop basic', async () => {
    const io = await ws.shell('for f in /data/subdir/a.txt /data/subdir/b.txt; do cat $f; done')
    const out = decode(io.stdout)
    expect(out).toContain('aaa')
    expect(out).toContain('bbb')
  })

  // bash 5.2: the loop variable is an ordinary variable and keeps its last
  // value after the loop; the shadowed value is not put back.
  it('for loop variable keeps its last value', async () => {
    await ws.shell('export i=original')
    await ws.shell('for i in 1 2 3; do echo $i; done')
    expect(ws.getSession(ws.defaultSessionId).env.i).toBe('3')
  })

  // ── If/else ──────────────────────────────────────────────────────

  it('if true branch', async () => {
    const io = await ws.shell(
      'if grep -q world /data/hello.txt; then echo found; else echo nope; fi',
    )
    expect(decode(io.stdout)).toContain('found')
  })

  it('if false branch', async () => {
    const io = await ws.shell(
      'if grep -q NOPE /data/hello.txt; then echo found; else echo nope; fi',
    )
    expect(decode(io.stdout)).toContain('nope')
  })

  // ── Complex combined ─────────────────────────────────────────────

  it('cd export grep pipe', async () => {
    await ws.shell('cd /data')
    await ws.shell('export TERM=ERROR')
    const io = await ws.shell('grep $TERM log.txt | wc -l')
    expect(decode(io.stdout).trim()).toBe('2')
  })

  it('subshell with redirect', async () => {
    await ws.shell('(echo from_subshell) > /data/sub_out.txt')
    const io = await ws.shell('cat /data/sub_out.txt')
    expect(decode(io.stdout)).toContain('from_subshell')
  })

  it('pipe into redirect', async () => {
    await ws.shell('grep ERROR /data/log.txt | sort > /data/errors.txt')
    const io = await ws.shell('cat /data/errors.txt')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('ERROR bad')
    expect(lines[1]).toBe('ERROR fail')
  })

  it('background with pipe', async () => {
    await ws.shell('cat /data/numbers.txt | sort | uniq &')
    const io = await ws.shell('wait %1')
    const lines = decode(io.stdout).trim().split('\n')
    expect([...lines].sort()).toEqual(['1', '2', '3'])
  })

  it('history tracks session id', async () => {
    ws.createSession('s-hist')
    ws.getSession('s-hist').cwd = '/'
    await ws.shell('echo tracked', { sessionId: 's-hist' })
    const records = (await ws.history()).filter((e) => e.session === 's-hist')
    expect(records.length).toBe(1)
    expect(records[0]?.command).toBe('echo tracked')
  })

  // ── grep exit codes ──────────────────────────────────────────────

  it('grep no match exit code', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt')
    expect(io.exitCode).toBe(1)
  })

  it('grep match exit code', async () => {
    const io = await ws.shell('grep hello /data/hello.txt')
    expect(io.exitCode).toBe(0)
  })

  it('grep -q match', async () => {
    const io = await ws.shell('grep -q world /data/hello.txt')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout).trim()).toBe('')
  })

  it('grep -q no match', async () => {
    const io = await ws.shell('grep -q NONEXISTENT /data/hello.txt')
    expect(io.exitCode).toBe(1)
  })

  it('grep and short-circuit', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt && echo should_not_appear')
    expect(decode(io.stdout)).not.toContain('should_not_appear')
  })

  it('grep or fallback', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt || echo fallback')
    expect(decode(io.stdout)).toContain('fallback')
  })

  it('grep if condition', async () => {
    const io = await ws.shell(
      'if grep -q world /data/hello.txt; then echo found; else echo nope; fi',
    )
    expect(decode(io.stdout)).toContain('found')
  })

  it('grep if no match', async () => {
    const io = await ws.shell(
      'if grep -q NOPE /data/hello.txt; then echo found; else echo nope; fi',
    )
    expect(decode(io.stdout)).toContain('nope')
  })

  it('grep pipe no match last stage wins', async () => {
    const io = await ws.shell('grep NONEXISTENT /data/hello.txt | sort')
    expect(io.exitCode).toBe(0)
  })

  it('grep pipe match', async () => {
    const io = await ws.shell('grep ERROR /data/log.txt | sort')
    expect(io.exitCode).toBe(0)
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('ERROR bad')
    expect(lines[1]).toBe('ERROR fail')
  })

  it('grep no match then or chain', async () => {
    const io = await ws.shell('grep NOPE /data/hello.txt || grep ERROR /data/log.txt | head -n 1')
    expect(decode(io.stdout)).toContain('ERROR')
  })

  it('grep count no match', async () => {
    const io = await ws.shell('grep -c NONEXISTENT /data/hello.txt')
    expect(decode(io.stdout).trim()).toBe('0')
  })

  it('grep count match', async () => {
    const io = await ws.shell('grep -c ERROR /data/log.txt')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout).trim()).toBe('2')
  })

  it('grep invert match', async () => {
    const io = await ws.shell('grep -v ERROR /data/log.txt')
    expect(io.exitCode).toBe(0)
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines.every((l) => !l.includes('ERROR'))).toBe(true)
  })

  it('grep invert no output', async () => {
    const io = await ws.shell('echo hello | grep -v hello')
    expect(decode(io.stdout).trim()).toBe('')
  })

  // ── rg exit codes ────────────────────────────────────────────────

  it('rg no match exit code', async () => {
    const io = await ws.shell('rg NONEXISTENT /data/hello.txt')
    expect(io.exitCode).toBe(1)
  })

  it('rg match exit code', async () => {
    const io = await ws.shell('rg hello /data/hello.txt')
    expect(io.exitCode).toBe(0)
  })

  it('rg no match and chain', async () => {
    const io = await ws.shell('rg NONEXISTENT /data/hello.txt && echo found')
    expect(decode(io.stdout)).not.toContain('found')
  })

  it('rg no match or chain', async () => {
    const io = await ws.shell('rg NONEXISTENT /data/hello.txt || echo fallback')
    expect(decode(io.stdout)).toContain('fallback')
  })

  it('rg pipe no match', async () => {
    const io = await ws.shell('rg NONEXISTENT /data/hello.txt | wc -l')
    expect(io.exitCode).toBe(0)
  })

  it('rg match pipe head', async () => {
    const io = await ws.shell('rg INFO /data/log.txt | head -n 1')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout)).toContain('INFO')
  })

  // ── diff exit codes ──────────────────────────────────────────────

  it('diff identical files', async () => {
    await ws.shell('echo same > /data/diff_a.txt')
    await ws.shell('echo same > /data/diff_b.txt')
    const io = await ws.shell('diff /data/diff_a.txt /data/diff_b.txt')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout).trim()).toBe('')
  })

  it('diff different files', async () => {
    await ws.shell('echo aaa > /data/diff_a.txt')
    await ws.shell('echo bbb > /data/diff_b.txt')
    const io = await ws.shell('diff /data/diff_a.txt /data/diff_b.txt')
    expect(io.exitCode).toBe(1)
    expect(decode(io.stdout).trim().length).toBeGreaterThan(0)
  })

  it('diff and chain', async () => {
    await ws.shell('echo same > /data/diff_a.txt')
    await ws.shell('echo same > /data/diff_b.txt')
    const io = await ws.shell('diff /data/diff_a.txt /data/diff_b.txt && echo identical')
    expect(decode(io.stdout)).toContain('identical')
  })

  it('diff or chain', async () => {
    await ws.shell('echo aaa > /data/diff_a.txt')
    await ws.shell('echo bbb > /data/diff_b.txt')
    const io = await ws.shell('diff /data/diff_a.txt /data/diff_b.txt || echo different')
    expect(decode(io.stdout)).toContain('different')
  })

  it('diff if identical', async () => {
    await ws.shell('echo same > /data/diff_a.txt')
    await ws.shell('echo same > /data/diff_b.txt')
    const io = await ws.shell(
      'if diff /data/diff_a.txt /data/diff_b.txt; then echo same; else echo changed; fi',
    )
    expect(decode(io.stdout)).toContain('same')
  })

  it('diff if different', async () => {
    await ws.shell('echo aaa > /data/diff_a.txt')
    await ws.shell('echo bbb > /data/diff_b.txt')
    const io = await ws.shell(
      'if diff /data/diff_a.txt /data/diff_b.txt; then echo same; else echo changed; fi',
    )
    expect(decode(io.stdout)).toContain('changed')
  })

  // ── find (verify already correct) ────────────────────────────────

  it('find existing', async () => {
    const io = await ws.shell('find /data/subdir')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout)).toContain('a.txt')
  })

  it('find with name', async () => {
    const io = await ws.shell('find /data/subdir -name a.txt')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout)).toContain('a.txt')
  })

  // ── Complex combined scenarios ───────────────────────────────────

  it('grep no match pipe redirect', async () => {
    await ws.shell(
      'grep NONEXISTENT /data/log.txt > /data/result.txt || echo none > /data/result.txt',
    )
    const io = await ws.shell('cat /data/result.txt')
    expect(decode(io.stdout)).toContain('none')
  })

  it('grep match and diff', async () => {
    await ws.shell('grep ERROR /data/log.txt > /data/errors.txt')
    await ws.shell("echo 'ERROR fail\nERROR bad' > /data/expected.txt")
    const io = await ws.shell('diff /data/errors.txt /data/expected.txt')
    expect([0, 1]).toContain(io.exitCode)
  })

  it('rg subshell isolation', async () => {
    const io = await ws.shell('(rg NONEXISTENT /data/hello.txt) || echo recovered')
    expect(decode(io.stdout)).toContain('recovered')
  })

  it('grep background exit code', async () => {
    await ws.shell('grep ERROR /data/log.txt &')
    const io = await ws.shell('wait %1')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stdout)).toContain('ERROR')
  })

  it('grep no match background', async () => {
    await ws.shell('grep NONEXISTENT /data/log.txt &')
    const io = await ws.shell('wait %1')
    expect(io.exitCode).toBe(1)
  })
})

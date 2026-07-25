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
import {
  countOccurrences,
  makeWorkspace,
  stdoutBytes,
  stdoutStr,
  stderrStr,
} from './fixtures/workspace_fixture.ts'

describe('workspace: general commands (seq/expr/bc/date/echo)', () => {
  it('seq N', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('seq 5')
    expect(stdoutStr(io)).toBe('1\n2\n3\n4\n5\n')
    await ws.close()
  })

  it('seq M N', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('seq 2 5')
    expect(stdoutStr(io)).toBe('2\n3\n4\n5\n')
    await ws.close()
  })

  it('seq -s sep', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('seq -s , 3')
    expect(stdoutStr(io)).toBe('1,2,3\n')
    await ws.close()
  })

  it('expr add', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('expr 2 + 3')
    expect(stdoutStr(io)).toContain('5')
    await ws.close()
  })

  it('expr multiply', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("expr 4 '*' 3")
    expect(stdoutStr(io)).toContain('12')
    await ws.close()
  })

  it('bc basic', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("echo '2+3' | bc")
    expect(stdoutStr(io)).toContain('5')
    await ws.close()
  })

  it('date -I has year prefix 202x', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('date -I')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('202')
    await ws.close()
  })

  it('echo -e expands \\n', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("echo -e 'hello\\nworld'")
    expect(stdoutStr(io)).toBe('hello\nworld\n')
    await ws.close()
  })

  it('echo -n no newline', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo -n hello')
    expect(stdoutStr(io)).toBe('hello')
    await ws.close()
  })

  it('seq 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('seq 1')
    expect(stdoutStr(io)).toBe('1\n')
    await ws.close()
  })

  it('seq inside $(...) iterates in for', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for n in $(seq 3); do echo $n; done')
    const out = stdoutStr(io)
    expect(out).toContain('1')
    expect(out).toContain('3')
    await ws.close()
  })

  it('sort empty stdin exits 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("echo -n '' | sort")
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('sort single line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hello | sort')
    expect(stdoutStr(io)).toContain('hello')
    await ws.close()
  })

  it('expr 0+0 returns 1 (GNU expr semantics)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('expr 0 + 0')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('seq | sort -rn', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('seq 5 | sort -rn')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines).toEqual(['5', '4', '3', '2', '1'])
    await ws.close()
  })
})

describe('workspace: sort as resource command', () => {
  it('sort file', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sort /ram/nums.txt')
    expect(io.exitCode).toBe(0)
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines).toEqual(['1', '2', '3', '4', '5'])
    await ws.close()
  })

  it('sort -r reverse', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sort -r /ram/nums.txt')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines).toEqual(['5', '4', '3', '2', '1'])
    await ws.close()
  })

  it('sort stdin numeric', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("echo '3\n1\n2' | sort -n")
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('sort -u unique', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sort -u /ram/words.txt')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines.length).toBe(3)
    await ws.close()
  })
})

describe('workspace: cross-mount commands (cp/mv/diff/cmp)', () => {
  it('cp s3 → disk', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cp /s3/data.txt /disk/data_copy.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /disk/data_copy.txt')
    expect(stdoutStr(io2)).toContain('hello from s3')
    await ws.close()
  })

  it('cp disk → ram', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo test_data > /disk/new.txt')
    const io = await ws.execute('cp /disk/new.txt /ram/new_copy.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /ram/new_copy.txt')
    expect(stdoutStr(io2)).toContain('test_data')
    await ws.close()
  })

  it('mv disk → ram removes source', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo moveme > /disk/moveme.txt')
    const io = await ws.execute('mv /disk/moveme.txt /ram/moved.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /ram/moved.txt')
    expect(stdoutStr(io2)).toContain('moveme')
    const io3 = await ws.execute('cat /disk/moveme.txt')
    expect(io3.exitCode).toBe(1)
    await ws.close()
  })

  it('diff identical files exits 0', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo same > /disk/a.txt')
    await ws.execute('echo same > /ram/b.txt')
    const io = await ws.execute('diff /disk/a.txt /ram/b.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('diff different files exits 1 with markers', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo aaa > /disk/a.txt')
    await ws.execute('echo bbb > /ram/b.txt')
    const io = await ws.execute('diff /disk/a.txt /ram/b.txt')
    expect(io.exitCode).toBe(1)
    const out = stdoutStr(io)
    // GNU normal-diff format (cross-mount diff now routes through the shared
    // generic, matching single-mount: "1c1 / < aaa / --- / > bbb").
    expect(out).toContain('---')
    expect(out).toContain('< aaa')
    expect(out).toContain('> bbb')
    await ws.close()
  })

  it('cmp identical → 0', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo identical > /disk/a.txt')
    await ws.execute('echo identical > /ram/b.txt')
    const io = await ws.execute('cmp /disk/a.txt /ram/b.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('cmp different → 1 with "differ"', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo xxx > /disk/a.txt')
    await ws.execute('echo yyy > /ram/b.txt')
    const io = await ws.execute('cmp /disk/a.txt /ram/b.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toContain('differ')
    await ws.close()
  })

  it('cmp same-mount differ message ends with newline', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo xxx > /ram/a.txt')
    await ws.execute('echo yyy > /ram/b.txt')
    const io = await ws.execute('cmp /ram/a.txt /ram/b.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('/ram/a.txt /ram/b.txt differ: char 1, line 1\n')
    await ws.close()
  })
})

describe('workspace: grep -l / -m early termination', () => {
  it('grep -l returns matching filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('grep -l alice /s3/report.csv')
    const out = stdoutStr(io)
    expect(out).toContain('report.csv')
    expect(out).not.toContain('alice,30')
    await ws.close()
  })

  it('grep -m 1 limits output to 1 match', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('grep -m 1 GET /s3/access.log')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('GET')
    await ws.close()
  })
})

describe('workspace: for loop break / continue / test / arith / while', () => {
  it('break preserves output before break', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in a b c; do echo $x; break; done')
    expect(stdoutStr(io)).toBe('a\n')
    await ws.close()
  })

  it('for with [ $x = c ] break', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in a b c d; do if [ $x = c ]; then break; fi; echo $x; done')
    expect(stdoutStr(io)).toBe('a\nb\n')
    await ws.close()
  })

  it('for with [ $x = b ] continue skips', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'for x in a b c d; do if [ $x = b ]; then continue; fi; echo $x; done',
    )
    expect(stdoutStr(io)).toBe('a\nc\nd\n')
    await ws.close()
  })

  it('continue inside true branch', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in a b c; do if true; then echo $x; continue; fi; done')
    expect(stdoutStr(io)).toBe('a\nb\nc\n')
    await ws.close()
  })

  it('[ a = a ] works; [ a = b ] fails', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('[ a = a ] && echo yes || echo no'))).toBe('yes\n')
    expect(stdoutStr(await ws.execute('[ a = b ] && echo yes || echo no'))).toBe('no\n')
    await ws.close()
  })

  it('[ $var = value ] expands', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in a c; do [ $x = c ] && echo match || echo miss; done')
    expect(stdoutStr(io)).toBe('miss\nmatch\n')
    await ws.close()
  })

  it('[ -lt -gt -eq ] numeric', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('[ 1 -lt 3 ] && echo yes || echo no'))).toBe('yes\n')
    expect(stdoutStr(await ws.execute('[ 3 -gt 1 ] && echo yes || echo no'))).toBe('yes\n')
    expect(stdoutStr(await ws.execute('[ 2 -eq 2 ] && echo yes || echo no'))).toBe('yes\n')
    await ws.close()
  })

  it('$((...)) arithmetic expansion', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('echo $((1 + 2))'))).toBe('3\n')
    expect(stdoutStr(await ws.execute('x=5; echo $(($x + 1))'))).toBe('6\n')
    await ws.close()
  })

  it('while [ $x -lt 3 ] with arith increment', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('x=0; while [ $x -lt 3 ]; do echo $x; x=$(($x + 1)); done')
    expect(stdoutStr(io)).toBe('0\n1\n2\n')
    await ws.close()
  })

  it('eval echo', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('eval "echo hello"'))).toBe('hello\n')
    await ws.close()
  })

  it('eval with variable expansion', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('x=hello; eval "echo $x"'))).toBe('hello\n')
    await ws.close()
  })

  it('bash -c basic', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute("bash -c 'echo hello'"))).toBe('hello\n')
    await ws.close()
  })

  it('bash -lc combined short flags', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("bash -lc 'echo combined'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('combined\n')
    await ws.close()
  })

  it('sh -c is an alias for bash', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('sh -c "echo via-sh"'))).toBe('via-sh\n')
    await ws.close()
  })

  it('bash -lc with for-loop over mount paths', async () => {
    const { ws } = await makeWorkspace()
    const cmd =
      'bash -lc \'for f in /s3/data.txt /s3/report.csv; do echo "== $f =="; head -n 1 "$f"; done\''
    const io = await ws.execute(cmd)
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('== /s3/data.txt ==')
    expect(out).toContain('== /s3/report.csv ==')
    expect(out).toContain('hello from s3')
    expect(out).toContain('name,age')
    await ws.close()
  })

  it('bash -c routes pipes back through Mirage shell', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("bash -c 'echo hello | tr a-z A-Z'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('HELLO\n')
    await ws.close()
  })

  it('bash -c forwards piped stdin to the inner line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("echo hi | bash -c 'cat'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })

  it('bash -s reads script from stdin', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo "echo from-stdin" | bash -s')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('from-stdin\n')
    await ws.close()
  })

  it('bash -c without an argument errors', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('bash -c')
    expect(io.exitCode).toBe(2)
    expect(stderrStr(io)).toContain('-c')
    await ws.close()
  })

  it('man bash renders the bash spec', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('man bash')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('# bash')
    expect(out).toContain('-c')
    expect(out).toContain('shell builtin')
    const io2 = await ws.execute('man sh')
    expect(io2.exitCode).toBe(0)
    expect(stdoutStr(io2)).toContain('# sh')
    await ws.close()
  })
})

describe('workspace: function fixes', () => {
  it('return N propagates for || &&', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.execute('check() { return 1; }; check || echo failed'))).toBe(
      'failed\n',
    )
    expect(stdoutStr(await ws.execute('ok() { return 0; }; ok && echo success'))).toBe('success\n')
    await ws.close()
  })

  it('local scope restores after return', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('x=outside; f() { local x=inside; echo $x; }; f; echo $x')
    expect(stdoutStr(io)).toBe('inside\noutside\n')
    await ws.close()
  })

  it('shift inside function', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('f() { echo $1; shift; echo $1; }; f a b')
    expect(stdoutStr(io)).toBe('a\nb\n')
    await ws.close()
  })

  it('nested function output preserved', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('inner() { echo inner; }; outer() { inner; echo outer; }; outer')
    expect(stdoutStr(io)).toBe('inner\nouter\n')
    await ws.close()
  })
})

describe('workspace: cross-mount multi-file cat/head/grep/wc', () => {
  it('cat files from different mounts concatenated', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/data.txt /disk/readme.txt')
    const out = stdoutStr(io)
    expect(out).toContain('hello from s3')
    expect(out).toContain('disk readme')
    await ws.close()
  })

  it('head -n 1 across mounts with headers', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('head -n 1 /s3/data.txt /disk/readme.txt')
    const out = stdoutStr(io)
    expect(out).toContain('==> /s3/data.txt <==')
    expect(out).toContain('==> /disk/readme.txt <==')
    await ws.close()
  })

  it('grep across mounts prefixes filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('grep hello /s3/data.txt /disk/readme.txt')
    expect(stdoutStr(io)).toContain('/s3/data.txt:')
    await ws.close()
  })

  it('wc -l across mounts shows per-file counts', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('wc -l /s3/data.txt /disk/readme.txt')
    const out = stdoutStr(io)
    expect(out).toContain('/s3/data.txt')
    expect(out).toContain('/disk/readme.txt')
    await ws.close()
  })
})

describe('workspace: while loop iteration limit warning', () => {
  it('while true emits warning after MAX iterations', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('while true; do export X=$X.; done')
    const err = stderrStr(io)
    expect(err).toContain('warning')
    expect(err).toContain('terminated after')
    expect(err).toContain('10000')
    await ws.close()
  })

  it('while under limit has no warning', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('i=0; while [ $i -lt 5 ]; do i=$((i+1)); done')
    const err = stderrStr(io)
    expect(err).not.toContain('warning')
    await ws.close()
  })
})

describe('workspace: count occurrences helper sanity', () => {
  it('handles empty buf', () => {
    expect(countOccurrences(new Uint8Array(), 'x')).toBe(0)
  })

  it('counts multi occurrences', () => {
    expect(
      countOccurrences(stdoutBytes({ stdout: new TextEncoder().encode('a b a c a') }), 'a'),
    ).toBe(3)
  })
})

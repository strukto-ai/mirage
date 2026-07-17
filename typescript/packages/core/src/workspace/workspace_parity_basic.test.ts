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
} from './fixtures/workspace_fixture.ts'

describe('workspace: basic commands', () => {
  it('cat reads a file', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('cat missing file returns non-zero exit', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/nonexistent.txt')
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })

  it('ls on a directory', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('ls /disk/')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('head reads a file', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('head /ram/notes.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('line1')
    await ws.close()
  })
})

describe('workspace: export / env', () => {
  it('export sets session env', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export MSG=hello')
    expect(ws.getSession(ws.defaultSessionId).env.MSG).toBe('hello')
    await ws.close()
  })

  it('exported var used in command', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export DIR=/s3')
    const io = await ws.execute('cat $DIR/report.csv')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })
})

describe('workspace: cd', () => {
  it('cd sets cwd', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cd /disk')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe('/disk')
    await ws.close()
  })

  it('cd to nonexistent returns non-zero', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cd /nonexistent')
    expect(io.exitCode).not.toBe(0)
    await ws.close()
  })
})

describe('workspace: pipeline', () => {
  it('cat | sort', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv | sort')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('cat | wc', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /ram/notes.txt | wc')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})

describe('workspace: redirect', () => {
  it('write with >', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/data.txt > /disk/out.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /disk/out.txt')
    expect(stdoutStr(io2)).toContain('hello from s3')
    await ws.close()
  })

  it('append with >>', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/data.txt > /disk/log.txt')
    await ws.execute('cat /s3/report.csv >> /disk/log.txt')
    const io = await ws.execute('cat /disk/log.txt')
    const out = stdoutStr(io)
    expect(out).toContain('hello from s3')
    expect(out).toContain('alice')
    await ws.close()
  })
})

describe('workspace: control flow', () => {
  it('if true', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('if true; then export R=yes; fi')
    expect(ws.getSession(ws.defaultSessionId).env.R).toBe('yes')
    await ws.close()
  })

  it('if false else', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('if false; then export R=yes; else export R=no; fi')
    expect(ws.getSession(ws.defaultSessionId).env.R).toBe('no')
    await ws.close()
  })

  it('for loop', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('for x in a b c; do export LAST=$x; done')
    expect(ws.getSession(ws.defaultSessionId).env.LAST).toBe('c')
    await ws.close()
  })

  it('while false', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('while false; do export RAN=yes; done')
    expect(io.exitCode).toBe(0)
    expect('RAN' in ws.getSession(ws.defaultSessionId).env).toBe(false)
    await ws.close()
  })

  it('case match', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('case hello in hello) export M=yes;; esac')
    expect(ws.getSession(ws.defaultSessionId).env.M).toBe('yes')
    await ws.close()
  })
})

describe('workspace: operators', () => {
  it('semicolons chain', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export A=1; export B=2; export C=3')
    const s = ws.getSession(ws.defaultSessionId)
    expect(s.env.A).toBe('1')
    expect(s.env.B).toBe('2')
    expect(s.env.C).toBe('3')
    await ws.close()
  })

  it('&& chain', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('true && export OK=yes')
    expect(ws.getSession(ws.defaultSessionId).env.OK).toBe('yes')
    await ws.close()
  })

  it('&& short-circuits on false', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('false && export SKIP=yes')
    expect('SKIP' in ws.getSession(ws.defaultSessionId).env).toBe(false)
    await ws.close()
  })

  it('|| fallback', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('false || export FALL=yes')
    expect(ws.getSession(ws.defaultSessionId).env.FALL).toBe('yes')
    await ws.close()
  })
})

describe('workspace: subshell', () => {
  it('subshell isolates env', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export X=outer')
    await ws.execute('(export X=inner)')
    expect(ws.getSession(ws.defaultSessionId).env.X).toBe('outer')
    await ws.close()
  })
})

describe('workspace: function', () => {
  it('define and call', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('greet() { export MSG=hello; }; greet')
    expect(ws.getSession(ws.defaultSessionId).env.MSG).toBe('hello')
    await ws.close()
  })

  it('with args', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('f() { export A=$1; export B=$2; }; f x y')
    const s = ws.getSession(ws.defaultSessionId)
    expect(s.env.A).toBe('x')
    expect(s.env.B).toBe('y')
    await ws.close()
  })
})

describe('workspace: negation', () => {
  it('! true -> exit 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('! true')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('! false -> exit 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('! false')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})

describe('workspace: brace group', () => {
  it('{ ... } runs sequentially in same session', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('{ export A=1; export B=2; }')
    const s = ws.getSession(ws.defaultSessionId)
    expect(s.env.A).toBe('1')
    expect(s.env.B).toBe('2')
    await ws.close()
  })
})

describe('workspace: variable expansion', () => {
  it('$F expands to full path', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export F=/s3/report.csv')
    const io = await ws.execute('cat $F')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('$DIR concatenates with /file', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export DIR=/s3')
    const io = await ws.execute('cat $DIR/data.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('hello from s3')
    await ws.close()
  })
})

describe('workspace: assignment', () => {
  it('bare assignment X=hello', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('X=hello')
    expect(ws.getSession(ws.defaultSessionId).env.X).toBe('hello')
    await ws.close()
  })

  it('assignment expands vars', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export BASE=/s3')
    await ws.execute('OUT=$BASE/result.txt')
    expect(ws.getSession(ws.defaultSessionId).env.OUT).toBe('/s3/result.txt')
    await ws.close()
  })
})

describe('workspace: while read', () => {
  it('reads stdin lines', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('while read LINE; do export LAST=$LINE; done', {
      stdin: new TextEncoder().encode('a\nb\nc\n'),
    })
    expect(ws.getSession(ws.defaultSessionId).env.LAST).toBe('c')
    await ws.close()
  })
})

describe('workspace: cross-mount', () => {
  it('cat from different mounts', async () => {
    const { ws } = await makeWorkspace()
    const io1 = await ws.execute('cat /s3/report.csv')
    const io2 = await ws.execute('cat /ram/notes.txt')
    expect(io1.exitCode).toBe(0)
    expect(io2.exitCode).toBe(0)
    expect(stdoutStr(io1)).toContain('alice')
    expect(stdoutStr(io2)).toContain('line1')
    await ws.close()
  })
})

describe('workspace: complex pipeline + redirect + expansion', () => {
  it('expansion + pipeline + redirect', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export DIR=/disk')
    const io = await ws.execute('cat /s3/report.csv | grep alice > $DIR/result.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /disk/result.txt')
    expect(stdoutStr(io2)).toContain('alice')
    await ws.close()
  })

  it('for with redirect', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('for name in hello world; do echo $name > /disk/$name.txt; done')
    const io1 = await ws.execute('cat /disk/hello.txt')
    const io2 = await ws.execute('cat /disk/world.txt')
    expect(stdoutStr(io1)).toContain('hello')
    expect(stdoutStr(io2)).toContain('world')
    await ws.close()
  })
})

describe('workspace: session isolation', () => {
  it('separate sessions have separate envs', async () => {
    const { ws } = await makeWorkspace()
    ws.createSession('worker')
    await ws.execute('export X=default')
    expect('X' in ws.getSession('worker').env).toBe(false)
    await ws.close()
  })
})

describe('workspace: exit code', () => {
  it('true → 0, false → 1', async () => {
    const { ws } = await makeWorkspace()
    expect((await ws.execute('true')).exitCode).toBe(0)
    expect((await ws.execute('false')).exitCode).toBe(1)
    await ws.close()
  })

  it('last_exit_code tracks last command', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('true')
    expect(ws.getSession(ws.defaultSessionId).lastExitCode).toBe(0)
    await ws.execute('false')
    expect(ws.getSession(ws.defaultSessionId).lastExitCode).toBe(1)
    await ws.close()
  })
})

// ═══════════════════════════════════════════════
// Complex nested: real-world patterns
// ═══════════════════════════════════════════════

describe('workspace: complex nested patterns', () => {
  it('ETL pipeline: cat | grep > disk, then verify', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/report.csv | grep alice > /disk/filtered.txt')
    const io = await ws.execute('cat /disk/filtered.txt')
    const out = stdoutStr(io)
    expect(out).toContain('alice')
    expect(out).not.toContain('bob')
    await ws.close()
  })

  it('multi-step processing with env + for', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      'export SRC=/s3; export DST=/disk; for f in report.csv data.txt; do cat $SRC/$f > $DST/$f; done',
    )
    const io1 = await ws.execute('cat /disk/report.csv')
    const io2 = await ws.execute('cat /disk/data.txt')
    expect(stdoutStr(io1)).toContain('alice')
    expect(stdoutStr(io2)).toContain('hello from s3')
    await ws.close()
  })

  it('conditional processing: if pipeline success; then write', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      'if cat /s3/report.csv | grep alice; then echo found > /disk/status.txt; else echo missing > /disk/status.txt; fi',
    )
    const io = await ws.execute('cat /disk/status.txt')
    expect(stdoutStr(io)).toContain('found')
    await ws.close()
  })

  it('function with pipeline and redirect', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('process() { cat $1 | sort > $2; }; process /ram/notes.txt /disk/sorted.txt')
    const io = await ws.execute('cat /disk/sorted.txt')
    const out = stdoutStr(io)
    expect(out).toContain('line1')
    const lines = out.trim().split('\n')
    expect(lines).toEqual([...lines].sort())
    await ws.close()
  })

  it('while read with conditional write (case)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      'while read LINE; do case $LINE in alice*) echo $LINE >> /disk/matches.txt;; esac; done',
      { stdin: new TextEncoder().encode('alice,30\nbob,25\nalice,40\n') },
    )
    const io = await ws.execute('cat /disk/matches.txt')
    const out = stdoutBytes(io)
    expect(countOccurrences(out, 'alice')).toBe(2)
    expect(stdoutStr(io)).not.toContain('bob')
    await ws.close()
  })

  it('nested for across mounts', async () => {
    const { ws } = await makeWorkspace()
    const s = ws.getSession(ws.defaultSessionId)
    await ws.execute(
      'for src in /s3 /ram; do for f in report.csv notes.txt; do cat $src/$f && export FOUND=$src/$f; done; done',
    )
    expect('FOUND' in s.env).toBe(true)
    await ws.close()
  })

  it('background sleep + foreground work', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('sleep 0.01 & export A=1; export B=2; cat /s3/report.csv > /disk/copy.txt')
    const s = ws.getSession(ws.defaultSessionId)
    expect(s.env.A).toBe('1')
    expect(s.env.B).toBe('2')
    const io = await ws.execute('cat /disk/copy.txt')
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('subshell pipeline redirect', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('(export TMP=inner; cat /s3/report.csv) | sort > /disk/out.txt')
    const s = ws.getSession(ws.defaultSessionId)
    expect('TMP' in s.env).toBe(false)
    const io = await ws.execute('cat /disk/out.txt')
    expect(stdoutBytes(io).byteLength).toBeGreaterThan(0)
    await ws.close()
  })

  it('brace group pipeline', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('{ echo header; cat /s3/report.csv; } | sort > /disk/combined.txt')
    const io = await ws.execute('cat /disk/combined.txt')
    const out = stdoutStr(io)
    expect(out).toContain('header')
    expect(out).toContain('alice')
    await ws.close()
  })

  it('for with numbered file redirects', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('for n in 1 2 3; do echo "file $n" > /disk/f$n.txt; done')
    const io1 = await ws.execute('cat /disk/f1.txt')
    const io3 = await ws.execute('cat /disk/f3.txt')
    expect(stdoutStr(io1)).toContain('file 1')
    expect(stdoutStr(io3)).toContain('file 3')
    await ws.close()
  })

  it('multi pipeline chain with &&', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv | grep alice && echo found')
    expect(stdoutStr(io)).toContain('found')
    await ws.close()
  })

  it('error handling with || fallback', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/missing.txt || echo fallback')
    expect(stdoutStr(io)).toContain('fallback')
    await ws.close()
  })

  it('full script simulation', async () => {
    const { ws } = await makeWorkspace()
    const script =
      'export SRC=/s3; export DST=/disk; ' +
      'if cat $SRC/report.csv | grep alice; then ' +
      'cat $SRC/report.csv | sort > $DST/sorted.txt; ' +
      'echo done > $DST/status.txt; ' +
      'else echo no_data > $DST/status.txt; fi'
    await ws.execute(script)
    const ioStatus = await ws.execute('cat /disk/status.txt')
    expect(stdoutStr(ioStatus)).toContain('done')
    const ioSorted = await ws.execute('cat /disk/sorted.txt')
    const out = stdoutStr(ioSorted)
    expect(out).toContain('alice')
    const lines = out.trim().split('\n')
    expect(lines).toEqual([...lines].sort())
    await ws.close()
  })
})

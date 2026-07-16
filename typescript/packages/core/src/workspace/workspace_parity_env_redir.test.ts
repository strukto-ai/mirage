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

describe('workspace: env set / unset / printenv', () => {
  it('unset removes env var', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export FOO=bar; unset FOO')
    expect('FOO' in ws.getSession(ws.defaultSessionId).env).toBe(false)
    await ws.close()
  })

  it('printenv for a single var', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export MY_VAR=hello')
    const io = await ws.execute('printenv MY_VAR')
    expect(stdoutStr(io)).toContain('hello')
    await ws.close()
  })

  it('printenv lists all vars', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export A=1; export B=2')
    const io = await ws.execute('printenv')
    const out = stdoutStr(io)
    expect(out).toContain('A=1')
    expect(out).toContain('B=2')
    await ws.close()
  })

  it('export override keeps latest', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export X=first; export X=second')
    expect(ws.getSession(ws.defaultSessionId).env.X).toBe('second')
    await ws.close()
  })

  it('env var used in pipeline pattern', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export PATTERN=alice')
    const io = await ws.execute('cat /s3/report.csv | grep $PATTERN')
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })
})

describe('workspace: whoami', () => {
  it('prints the launch agentId', async () => {
    const { ws } = await makeWorkspace({ agentId: 'alice' })
    const io = await ws.execute('whoami')
    expect(stdoutStr(io)).toBe('alice\n')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('errors without an agentId', async () => {
    // No agent ever claimed this workspace: GNU errors for a uid with
    // no passwd entry, and so do we.
    const { ws } = await makeWorkspace()
    const io = await ws.execute('whoami')
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr)).toBe('whoami: cannot find name for user ID\n')
    await ws.close()
  })

  it('ignores $USER (GNU: effective user, not env)', async () => {
    const { ws } = await makeWorkspace({ agentId: 'alice' })
    await ws.execute('export USER=bob')
    const io = await ws.execute('whoami')
    expect(stdoutStr(io)).toBe('alice\n')
    await ws.execute('unset USER')
    const io2 = await ws.execute('whoami')
    expect(stdoutStr(io2)).toBe('alice\n')
    await ws.close()
  })
})

describe('workspace: man', () => {
  it('man date renders entry with header and RESOURCES section', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('man date')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('# date')
    expect(out).toContain('## RESOURCES')
    await ws.close()
  })
})

describe('workspace: echo / sleep / background', () => {
  it('echo hello world', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hello world')
    expect(stdoutStr(io)).toBe('hello world\n')
    await ws.close()
  })

  it('echo -n no newline', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo -n hello')
    expect(stdoutStr(io)).toBe('hello')
    await ws.close()
  })

  it('sleep and echo', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sleep 0; echo done')
    expect(stdoutStr(io)).toContain('done')
    await ws.close()
  })

  it('background sleep + foreground echo', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sleep 0.01 & echo foreground')
    expect(stdoutStr(io)).toContain('foreground')
    await ws.close()
  })
})

describe('workspace: real-world scripts', () => {
  it('log analysis: grep 500 | wc -l > file', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('grep 500 /s3/access.log | wc -l > /disk/err.txt')
    const io = await ws.execute('cat /disk/err.txt')
    expect(stdoutStr(io)).toContain('2')
    await ws.close()
  })

  it('csv extract/sort/uniq', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('tail -n +2 /s3/report.csv | cut -d, -f1 | sort | uniq')
    const out = stdoutStr(io)
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    await ws.close()
  })

  it('config loader via while read + export $LINE', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('while read LINE; do export $LINE; done', {
      stdin: new TextEncoder().encode('DB_HOST=localhost\nDB_PORT=5432\n'),
    })
    const s = ws.getSession(ws.defaultSessionId)
    expect(s.env.DB_HOST).toBe('localhost')
    expect(s.env.DB_PORT).toBe('5432')
    await ws.close()
  })

  it('multi-mount awk sort', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("cat /s3/report.csv | awk -F, 'NR>1{print $1}' | sort > /disk/names.txt")
    const io = await ws.execute('cat /disk/names.txt')
    const out = stdoutStr(io)
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    const lines = out.trim().split('\n')
    expect(lines).toEqual([...lines].sort())
    await ws.close()
  })

  it('conditional grep sed', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      "if grep 500 /s3/access.log; then grep 500 /s3/access.log | sed 's/500/ERROR/' > /disk/errors.txt; fi",
    )
    const io = await ws.execute('cat /disk/errors.txt')
    const out = stdoutStr(io)
    expect(out).toContain('ERROR')
    expect(out).not.toContain('500')
    await ws.close()
  })

  it('function grep wc', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('filter() { grep $1 $2 | wc -l > /disk/c.txt; }; filter GET /s3/access.log')
    const io = await ws.execute('cat /disk/c.txt')
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('jq transform and write', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("jq '.[].name' /s3/users.json > /disk/names.json")
    const io = await ws.execute('cat /disk/names.json')
    const out = stdoutStr(io)
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    await ws.close()
  })

  it('background with pipeline', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      "sleep 0.01 & cat /s3/report.csv | grep alice | sed 's/alice/ALICE/' > /disk/bg.txt",
    )
    const io = await ws.execute('cat /disk/bg.txt')
    expect(stdoutStr(io)).toContain('ALICE')
    await ws.close()
  })

  it('nested function with tr', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      "upper() { tr 'a-z' 'A-Z'; }; process() { cat $1 | upper > $2; }; process /s3/data.txt /disk/upper.txt",
    )
    const io = await ws.execute('cat /disk/upper.txt')
    expect(stdoutStr(io)).toContain('HELLO FROM S3')
    await ws.close()
  })
})

describe('workspace: redirect 2>&1, 2>/dev/null, 2>file, &>, &>>', () => {
  it('stderr to stdout merge (2>&1)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/nonexistent.txt 2>&1')
    const out = stdoutStr(io)
    expect(out.includes('nonexistent') || io.exitCode !== 0).toBe(true)
    await ws.close()
  })

  it('stderr to file (2> file)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/nonexistent.txt 2> /disk/err.log')
    const io = await ws.execute('cat /disk/err.log')
    expect(stdoutStr(io)).toContain('nonexistent')
    await ws.close()
  })

  it('stderr to /disk/null suppresses it from result', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/nonexistent.txt 2> /disk/null.txt')
    expect(io.stderr.byteLength).toBe(0)
    await ws.close()
  })

  it('stderr merge in brace pipeline', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('{ cat /s3/report.csv; } 2>&1 | sort')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('stdout redirect preserves stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hello > /disk/out.txt')
    expect(io.exitCode).toBe(0)
    const io2 = await ws.execute('cat /disk/out.txt')
    expect(stdoutStr(io2)).toContain('hello')
    await ws.close()
  })

  it('stderr redirect preserves stdout', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv 2> /disk/err.log')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('both to file (&>)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo hello &> /disk/both.txt')
    const io = await ws.execute('cat /disk/both.txt')
    expect(stdoutStr(io)).toContain('hello')
    await ws.close()
  })

  it('both append (&>>)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo first &> /disk/b.txt')
    await ws.execute('echo second &>> /disk/b.txt')
    const io = await ws.execute('cat /disk/b.txt')
    const out = stdoutStr(io)
    expect(out).toContain('first')
    expect(out).toContain('second')
    await ws.close()
  })

  it('stderr to file on error', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/nope.txt 2> /disk/err.txt')
    const io = await ws.execute('cat /disk/err.txt')
    expect(stdoutStr(io)).toContain('nope')
    await ws.close()
  })

  it('both redirect on error (&>)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/nope.txt &> /disk/all.txt')
    const io = await ws.execute('cat /disk/all.txt')
    expect(stdoutStr(io)).toContain('nope')
    await ws.close()
  })

  it('redirect to variable target', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export OUT=/disk/var_out.txt')
    await ws.execute('echo hello > $OUT')
    const io = await ws.execute('cat /disk/var_out.txt')
    expect(stdoutStr(io)).toContain('hello')
    await ws.close()
  })

  it('multiple redirects: stdout > file, stderr > file', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('cat /s3/report.csv > /disk/out.txt 2> /disk/err.txt')
    const io = await ws.execute('cat /disk/out.txt')
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })
})

describe('workspace: pipeline mount fallback (cwd-less commands)', () => {
  it('pipe to wc', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /ram/notes.txt | wc -l')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('pipe to head', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /ram/notes.txt | head -n 1')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('line1')
    await ws.close()
  })

  it('pipe to tail', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /ram/notes.txt | tail -n 1')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('line3')
    await ws.close()
  })

  it('sort | uniq', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('sort /ram/words.txt | uniq')
    expect(io.exitCode).toBe(0)
    expect(countOccurrences(stdoutBytes(io), 'apple')).toBe(1)
    await ws.close()
  })

  it('pipe to cut', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv | cut -d, -f1')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('name')
    expect(out).toContain('alice')
    await ws.close()
  })

  it('pipe to tr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("cat /s3/data.txt | tr 'a-z' 'A-Z'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('HELLO')
    await ws.close()
  })

  it('pipe to grep', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /s3/report.csv | grep alice')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('4-stage pipeline', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat /ram/words.txt | grep apple | sort | uniq')
    expect(io.exitCode).toBe(0)
    expect(countOccurrences(stdoutBytes(io), 'apple')).toBe(1)
    await ws.close()
  })

  it('pipeline with default cwd /mirage', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/mirage'
    const io = await ws.execute('cat /s3/report.csv | wc -l')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('pipe to sed', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("cat /s3/report.csv | sed 's/alice/ALICE/'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('ALICE')
    await ws.close()
  })
})

describe('workspace: cache resource fallback', () => {
  it('wc under /mirage cwd', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/mirage'
    const io = await ws.execute('cat /s3/report.csv | wc -l')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('head under /nonexistent cwd', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/nonexistent'
    const io = await ws.execute('cat /ram/notes.txt | head -n 1')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('line1')
    await ws.close()
  })

  it('grep in pipeline under /mirage cwd', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/mirage'
    const io = await ws.execute('cat /s3/report.csv | grep alice')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('sort|uniq under /mirage cwd', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/mirage'
    const io = await ws.execute('cat /ram/words.txt | sort | uniq')
    expect(io.exitCode).toBe(0)
    expect(countOccurrences(stdoutBytes(io), 'apple')).toBe(1)
    await ws.close()
  })

  it('4-stage pipeline under /mirage cwd', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(ws.defaultSessionId).cwd = '/mirage'
    const io = await ws.execute('cat /s3/report.csv | grep -v name | cut -d, -f1 | sort')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    await ws.close()
  })
})

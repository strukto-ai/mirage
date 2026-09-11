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
import { makeWorkspace, stdoutStr } from './fixtures/workspace_fixture.ts'

describe('workspace: heredoc / herestring', () => {
  it('heredoc << EOF', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat << EOF\nhello\nworld\nEOF')
    expect(stdoutStr(io)).toBe('hello\nworld\n')
    await ws.close()
  })

  it('herestring <<<', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat <<< "hello world"')
    expect(stdoutStr(io)).toBe('hello world\n')
    await ws.close()
  })

  it('unquoted heredoc expands variables', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('X=world\ncat << EOF\nhello $X\nEOF')
    expect(stdoutStr(io)).toBe('hello world\n')
    await ws.close()
  })

  it("quoted heredoc ('EOF') keeps variables literal", async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("X=world\ncat << 'EOF'\nhello $X\nEOF")
    expect(stdoutStr(io)).toBe('hello $X\n')
    await ws.close()
  })

  it('<<- strips leading tabs', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cat <<-EOF\n\thello\n\tworld\nEOF')
    expect(stdoutStr(io)).toBe('hello\nworld\n')
    await ws.close()
  })

  it('heredoc inside for loop', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in a b c; do cat <<EOF\nitem=$x\nEOF\ndone')
    expect(stdoutStr(io)).toBe('item=a\nitem=b\nitem=c\n')
    await ws.close()
  })
})

describe('workspace: relative paths', () => {
  it('./file after cd', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo test > /disk/out.txt')
    const io = await ws.execute('cd /disk && cat ./out.txt')
    expect(stdoutStr(io)).toBe('test\n')
    await ws.close()
  })
})

describe('workspace: set -- positional args', () => {
  it('set -- a b c sets $@', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('set -- a b c; echo $@')
    expect(stdoutStr(io)).toBe('a b c\n')
    await ws.close()
  })

  it('set -- x y sets $1 $2', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('set -- x y; echo $1 $2')
    expect(stdoutStr(io)).toBe('x y\n')
    await ws.close()
  })
})

describe('workspace: glob expansion', () => {
  it('echo /s3/*.csv', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo /s3/*.csv')
    expect(stdoutStr(io)).toContain('report.csv')
    await ws.close()
  })

  it('for f in /ram/*.txt', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for f in /ram/*.txt; do echo $f; done')
    const out = stdoutStr(io)
    expect(out).toContain('notes.txt')
    expect(out).toContain('nums.txt')
    await ws.close()
  })

  it('$(echo a b c) word-splits in for', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in $(echo a b c); do echo item:$x; done')
    expect(stdoutStr(io)).toBe('item:a\nitem:b\nitem:c\n')
    await ws.close()
  })
})

describe('workspace: pipe exit code', () => {
  it('pipe with no match → exit 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hello | grep nope')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('pipe with match → exit 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hello | grep hello')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})

describe('workspace: timeout', () => {
  it('timeout N cmd runs command', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('timeout 5 echo hello')
    expect(stdoutStr(io)).toBe('hello\n')
    await ws.close()
  })
})

describe('workspace: xargs', () => {
  it('echo args | xargs echo', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo "a b c" | xargs echo')
    expect(stdoutStr(io)).toBe('a b c\n')
    await ws.close()
  })
})

describe('workspace: additional fixes', () => {
  it('for over empty list skips body', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for x in; do echo $x; done; echo done')
    expect(stdoutStr(io)).toBe('done\n')
    await ws.close()
  })

  it('escaped quotes inside double quotes', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo "hello \\"world\\""')
    expect(stdoutStr(io)).toBe('hello "world"\n')
    await ws.close()
  })

  it('"$@" in for splits into args', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('f() { for x in "$@"; do echo $x; done; }; f a b c')
    expect(stdoutStr(io)).toBe('a\nb\nc\n')
    await ws.close()
  })

  it('echo bg & echo fg', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo bg & echo fg')
    expect(stdoutStr(io)).toContain('fg')
    await ws.close()
  })
})

describe('workspace: CommandSpec PATH classification (bare filenames)', () => {
  it('cd + cat bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cd /disk/sub; cat deep.txt')
    expect(stdoutStr(io)).toBe('deep content\n')
    await ws.close()
  })

  it('cd + head bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cd /ram; head -n 2 notes.txt')
    expect(stdoutStr(io)).toBe('line1\nline2\n')
    await ws.close()
  })

  it('cd + wc bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cd /ram; wc -l notes.txt')
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('cd + grep bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('cd /s3; grep POST access.log')
    const out = stdoutStr(io)
    expect((out.match(/POST/g) ?? []).length).toBe(2)
    await ws.close()
  })

  it('bare filename in for loop stays text', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for f in notes.txt; do echo $f; done')
    expect(stdoutStr(io)).toBe('notes.txt\n')
    await ws.close()
  })

  it("find -name '*.txt' does not glob-expand", async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("find /s3 -name '*.txt'")
    expect(stdoutStr(io)).toContain('data.txt')
    await ws.close()
  })

  it('subshell + cd + cat bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('(cd /disk/sub; cat deep.txt)')
    expect(stdoutStr(io)).toContain('deep content')
    await ws.close()
  })
})

describe('workspace: job table cleanup', () => {
  it('bg sleep + kill + jobs cleanup', async () => {
    const { ws } = await makeWorkspace()
    // `kill %1` joins the job, so the killed status is already settled
    // when `jobs` lists it. After the listing, popCompleted removes it.
    const io = await ws.execute('sleep 10 & kill %1; jobs')
    expect(stdoutStr(io)).toContain('killed')
    const io2 = await ws.execute('jobs')
    expect(stdoutStr(io2)).toBe('')
    await ws.close()
  })

  it('wait by id reaps, so jobs is empty after it', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hi & wait %1; jobs')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })

  it('bare wait does not replay a targeted wait output', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hi & wait %1; wait')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })

  it('job numbering restarts once the table empties', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo a & wait %1; echo b & wait %1')
    expect(stdoutStr(io)).toBe('a\nb\n')
    await ws.close()
  })

  it('bare wait reaps, so jobs is empty after it', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo hi & wait; jobs')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })
})

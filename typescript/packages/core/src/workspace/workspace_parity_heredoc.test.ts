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
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'

describe('workspace: heredoc / herestring', () => {
  it('heredoc << EOF', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat << EOF\nhello\nworld\nEOF')
    expect(stdoutStr(io)).toBe('hello\nworld\n')
    await ws.close()
  })

  it('herestring <<<', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat <<< "hello world"')
    expect(stdoutStr(io)).toBe('hello world\n')
    await ws.close()
  })

  it('unquoted heredoc expands variables', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('X=world\ncat << EOF\nhello $X\nEOF')
    expect(stdoutStr(io)).toBe('hello world\n')
    await ws.close()
  })

  it("quoted heredoc ('EOF') keeps variables literal", async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("X=world\ncat << 'EOF'\nhello $X\nEOF")
    expect(stdoutStr(io)).toBe('hello $X\n')
    await ws.close()
  })

  it('<<- strips leading tabs', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat <<-EOF\n\thello\n\tworld\nEOF')
    expect(stdoutStr(io)).toBe('hello\nworld\n')
    await ws.close()
  })

  it('heredoc inside for loop', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('for x in a b c; do cat <<EOF\nitem=$x\nEOF\ndone')
    expect(stdoutStr(io)).toBe('item=a\nitem=b\nitem=c\n')
    await ws.close()
  })
})

describe('workspace: relative paths', () => {
  it('./file after cd', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell('echo test > /disk/out.txt')
    const io = await ws.shell('cd /disk && cat ./out.txt')
    expect(stdoutStr(io)).toBe('test\n')
    await ws.close()
  })
})

describe('workspace: set -- positional args', () => {
  it('set -- a b c sets $@', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('set -- a b c; echo $@')
    expect(stdoutStr(io)).toBe('a b c\n')
    await ws.close()
  })

  it('set -- x y sets $1 $2', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('set -- x y; echo $1 $2')
    expect(stdoutStr(io)).toBe('x y\n')
    await ws.close()
  })
})

describe('workspace: glob expansion', () => {
  it('echo /s3/*.csv', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo /s3/*.csv')
    expect(stdoutStr(io)).toContain('report.csv')
    await ws.close()
  })

  it('for f in /ram/*.txt', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('for f in /ram/*.txt; do echo $f; done')
    const out = stdoutStr(io)
    expect(out).toContain('notes.txt')
    expect(out).toContain('nums.txt')
    await ws.close()
  })

  it('$(echo a b c) word-splits in for', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('for x in $(echo a b c); do echo item:$x; done')
    expect(stdoutStr(io)).toBe('item:a\nitem:b\nitem:c\n')
    await ws.close()
  })
})

describe('workspace: pipe exit code', () => {
  it('pipe with no match → exit 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hello | grep nope')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('pipe with match → exit 0', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hello | grep hello')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})

describe('workspace: timeout', () => {
  it('timeout N cmd runs command', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('timeout 5 echo hello')
    expect(stdoutStr(io)).toBe('hello\n')
    await ws.close()
  })
})

describe('workspace: xargs', () => {
  it('echo args | xargs echo', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo "a b c" | xargs echo')
    expect(stdoutStr(io)).toBe('a b c\n')
    await ws.close()
  })
})

describe('workspace: additional fixes', () => {
  it('for over empty list skips body', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('for x in; do echo $x; done; echo done')
    expect(stdoutStr(io)).toBe('done\n')
    await ws.close()
  })

  it('escaped quotes inside double quotes', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo "hello \\"world\\""')
    expect(stdoutStr(io)).toBe('hello "world"\n')
    await ws.close()
  })

  it('"$@" in for splits into args', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('f() { for x in "$@"; do echo $x; done; }; f a b c')
    expect(stdoutStr(io)).toBe('a\nb\nc\n')
    await ws.close()
  })

  it('echo bg & echo fg', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo bg & echo fg')
    expect(stdoutStr(io)).toContain('fg')
    await ws.close()
  })
})

describe('workspace: CommandSpec PATH classification (bare filenames)', () => {
  it('cd + cat bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cd /disk/sub; cat deep.txt')
    expect(stdoutStr(io)).toBe('deep content\n')
    await ws.close()
  })

  it('cd + head bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cd /ram; head -n 2 notes.txt')
    expect(stdoutStr(io)).toBe('line1\nline2\n')
    await ws.close()
  })

  it('cd + wc bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cd /ram; wc -l notes.txt')
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('cd + grep bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cd /s3; grep POST access.log')
    const out = stdoutStr(io)
    expect((out.match(/POST/g) ?? []).length).toBe(2)
    await ws.close()
  })

  it('bare filename in for loop stays text', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('for f in notes.txt; do echo $f; done')
    expect(stdoutStr(io)).toBe('notes.txt\n')
    await ws.close()
  })

  it("find -name '*.txt' does not glob-expand", async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("find /s3 -name '*.txt'")
    expect(stdoutStr(io)).toContain('data.txt')
    await ws.close()
  })

  it('subshell + cd + cat bare filename', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('(cd /disk/sub; cat deep.txt)')
    expect(stdoutStr(io)).toContain('deep content')
    await ws.close()
  })
})

describe('workspace: job table cleanup', () => {
  it('bg sleep + kill + jobs cleanup', async () => {
    const { ws } = await makeWorkspace()
    // `kill %1` joins the job, so the killed status is already settled
    // when `jobs` lists it. After the listing, popCompleted removes it.
    const io = await ws.shell('sleep 10 & kill %1; jobs')
    expect(stdoutStr(io)).toContain('killed')
    const io2 = await ws.shell('jobs')
    expect(stdoutStr(io2)).toBe('')
    await ws.close()
  })

  it('wait by id reaps, so jobs is empty after it', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hi & wait %1; jobs')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })

  it('bare wait does not replay a targeted wait output', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hi & wait %1; wait')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })

  it('job numbering restarts once the table empties', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo a & wait %1; echo b & wait %1')
    expect(stdoutStr(io)).toBe('a\nb\n')
    await ws.close()
  })

  it('bare wait reaps, so jobs is empty after it', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hi & wait; jobs')
    expect(stdoutStr(io)).toBe('hi\n')
    await ws.close()
  })
})

// tree-sitter-bash used to lex a heredoc body line opening with a backslash
// as more words of the operator line, and to skip the first line's leading
// whitespace; parse() shields such bodies so the workspace reads them as
// bash does (issue #1050).
describe('workspace: heredoc bodies the lexer would swallow', () => {
  it('keeps a leading backslash line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n\\first\nsecond\nEND")
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })

  it('round-trips a leading backslash line through a file', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell("cat > /disk/HB <<'END'\n\\first\nsecond\nEND")
    const io = await ws.shell('cat /disk/HB')
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })

  it('keeps indentation after a backslash line', async () => {
    const { ws } = await makeWorkspace()
    const body = '\\begin{table}[!ht]\n  \\begin{center}\n  \\end{center}\n\\end{table}\n'
    const io = await ws.shell(`cat <<'END'\n${body}END`)
    expect(stdoutStr(io)).toBe(body)
    await ws.close()
  })

  it('keeps leading indentation', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n  first\nsecond\nEND")
    expect(stdoutStr(io)).toBe('  first\nsecond\n')
    await ws.close()
  })

  it('expands and escapes on an unquoted backslash line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('hb=val; cat <<END\n\\a $hb\n\\$hb\nsecond\nEND')
    expect(stdoutStr(io)).toBe('\\a val\n$hb\nsecond\n')
    await ws.close()
  })

  it('does not let a backslash line reach the pipeline', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END' | tr a-z A-Z\n\\first\nsecond\nEND")
    expect(stdoutStr(io)).toBe('\\FIRST\nSECOND\n')
    await ws.close()
  })

  it('reads an apostrophe on a backslash line as body text', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n\\item Don't stop; echo not-a-command\nsecond\nEND")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe("\\item Don't stop; echo not-a-command\nsecond\n")
    await ws.close()
  })

  it('keeps a tab-indented backslash line under <<-', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<-'END'\n\t\\first\n\tsecond\n\tEND")
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })
})

// bash keeps the empty lines a body opens with and reads a quoted
// delimiter with the shell's own escape rules; both reach the workspace
// through the heredoc package (issue #1050).
describe('workspace: heredoc leading empty lines and escaped delimiters', () => {
  it('keeps a leading empty line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n\nfirst\nEND")
    expect(stdoutStr(io)).toBe('\nfirst\n')
    await ws.close()
  })

  it('keeps a body that is one empty line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n\nEND")
    expect(stdoutStr(io)).toBe('\n')
    await ws.close()
  })

  it('keeps an empty line before a backslash line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<'END'\n\n\\first\nEND")
    expect(stdoutStr(io)).toBe('\n\\first\n')
    await ws.close()
  })

  it('expands after leading empty lines', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('hb=val; cat <<END\n\n\n$hb\nEND')
    expect(stdoutStr(io)).toBe('\n\nval\n')
    await ws.close()
  })

  it('keeps a leading empty line under <<-', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat <<-'END'\n\n\tfirst\n\tEND")
    expect(stdoutStr(io)).toBe('\nfirst\n')
    await ws.close()
  })

  it('reads an escaped dollar in a quoted delimiter', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat <<"E\\$F"\n\\first\nE$F')
    expect(stdoutStr(io)).toBe('\\first\n')
    await ws.close()
  })

  it('reads an escaped quote in a quoted delimiter', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat <<"E\\"F"\n\\first\nE"F')
    expect(stdoutStr(io)).toBe('\\first\n')
    await ws.close()
  })

  it('round-trips a leading empty line through a file', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell("cat > /disk/HB7 <<'END'\n\nfirst\nEND")
    const io = await ws.shell('cat /disk/HB7')
    expect(stdoutStr(io)).toBe('\nfirst\n')
    await ws.close()
  })
})

// A backslash before a newline in the delimiter is the reader's line
// continuation rather than quoting, so the body it opens expands, and the
// terminator line tree-sitter leaves in that body is not body text
// (issue #1050).
describe('workspace: heredoc continued delimiters', () => {
  it('expands the body of a continued delimiter', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('hb=val; cat <<EO\\\nF\n$hb\nEOF\n')
    expect(stdoutStr(io)).toBe('val\n')
    await ws.close()
  })

  it('drops the terminator line of a continued delimiter', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat <<EO\\\nF\nbody\nEOF\n')
    expect(stdoutStr(io)).toBe('body\n')
    await ws.close()
  })

  it('reads a continued delimiter carrying an escape as quoted', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('hb=val; cat <<EO\\\nF\\G\n$hb\nEOFG\n')
    expect(stdoutStr(io)).toBe('$hb\n')
    await ws.close()
  })

  it('keeps a body that expands to the delimiter', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('hb=END; cat <<END\n$hb\nEND')
    expect(stdoutStr(io)).toBe('END\n')
    await ws.close()
  })
})

// The operator line runs past a `)` that closes a case pattern and past
// the quotes a substitution inside double quotes holds, so the body it
// opens is the one bash reads (issue #1050).
describe('workspace: heredoc operator lines that hold a case or a nested quote', () => {
  it('keeps a backslash line after a case pattern paren', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(
      'cat <<EOF $(case x in\nx)\n  :\n  ;;\nesac\n)\n\\first\nsecond\nEOF\n',
    )
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })

  it('keeps indentation after a case pattern paren', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(
      'cat <<EOF $(case x in\nx)\n  :\n  ;;\nesac\n)\n  spaced\nsecond\nEOF\n',
    )
    expect(stdoutStr(io)).toBe('  spaced\nsecond\n')
    await ws.close()
  })

  it('keeps a backslash line after a quote inside a substitution', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell('cat <<EOF >"$( : "a\n  b"; echo /disk/HB8)"\n\\first\nsecond\nEOF\n')
    const io = await ws.shell('cat /disk/HB8')
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })

  it('keeps a backslash line after a quote inside a backtick', async () => {
    const { ws } = await makeWorkspace()
    await ws.shell('cat <<EOF >"`  : "a\n  b"; echo /disk/HB9 `"\n\\first\nsecond\nEOF\n')
    const io = await ws.shell('cat /disk/HB9')
    expect(stdoutStr(io)).toBe('\\first\nsecond\n')
    await ws.close()
  })
})

// Pinned against bash 5.2 on debian:stable-slim: the `&&`/`||` written on
// a heredoc's operator line wraps the heredoc'd command, as it would any
// other command. tree-sitter parses that tail inside the heredoc, which
// used to make `|| echo` a phantom pipe stage: the body was lost and the
// recovery never ran.
describe('workspace: heredoc operator-line list', () => {
  it.each([
    ["false <<'EOF' || echo recovered\nignored\nEOF", 'recovered\n', 0],
    ["cat <<'EOF' && echo after\nhello\nEOF", 'hello\nafter\n', 0],
    ['cat <<EOF 2>/dev/null || echo fb\nhello\nEOF', 'hello\n', 0],
    ["true <<'EOF' || echo notrun\nx\nEOF", '', 0],
    ["false <<'EOF' && echo notrun\nx\nEOF", '', 1],
    ['cat <<EOF | tr a-z A-Z && echo done\nabc\nEOF', 'ABC\ndone\n', 0],
    ['cat <<EOF | tr a-z A-Z | rev && echo c\nabc\nEOF', 'CBA\nc\n', 0],
    ['cat <<EOF | tr a-z A-Z || echo c && echo d\nabc\nEOF', 'ABC\nd\n', 0],
    ['false <<EOF || echo a && echo b\nx\nEOF', 'a\nb\n', 0],
    ['true <<EOF || echo a && echo b\nx\nEOF', 'b\n', 0],
    ['false <<EOF || echo a || echo b\nx\nEOF', 'a\n', 0],
    ['false <<EOF || echo a | tr a A\nx\nEOF', 'A\n', 0],
    ['false <<EOF || { echo a; echo b; }\nx\nEOF', 'a\nb\n', 0],
    ['false <<EOF || (echo x)\nx\nEOF', 'x\n', 0],
    ['false <<EOF || ! true\nx\nEOF', '', 1],
    ['true && cat <<EOF || echo x\nbody\nEOF', 'body\n', 0],
    ['cat <<-EOF && echo after\n\thello\n\tEOF', 'hello\nafter\n', 0],
    ['x=$(cat <<EOF && echo after\nhello\nEOF\n); echo "[$x]"', '[hello\nafter]\n', 0],
    ['if false <<EOF || true\nx\nEOF\nthen echo yes; fi', 'yes\n', 0],
    ['cat /nonexistent <<EOF 2>/dev/null || echo fb\nx\nEOF', 'fb\n', 0],
  ])('%j', async (line, stdout, exitCode) => {
    const { ws } = await makeWorkspace()
    try {
      const io = await ws.shell(line)
      expect([stdoutStr(io), stderrStr(io), io.exitCode]).toEqual([stdout, '', exitCode])
    } finally {
      await ws.close()
    }
  })

  it('a file redirect then a list', async () => {
    const { ws } = await makeWorkspace()
    try {
      const io = await ws.shell('cat <<EOF > /disk/ho && cat /disk/ho\ninner\nEOF')
      expect(stdoutStr(io)).toBe('inner\n')
    } finally {
      await ws.close()
    }
  })
})

// Pinned against bash 5.2 on debian:stable-slim: a terminator after the
// operator runs its tail after the heredoc command, an unquoted delimiter
// ends at a metacharacter, and the bodies of two heredocs on one line
// follow in source order (issue #1070).
describe('workspace: heredoc operator-line terminators', () => {
  it.each([
    ['cat <<EOF; echo x\nhi\nEOF', 'hi\nx\n', 0],
    ['cat <<EOF;echo x\nhi\nEOF', 'hi\nx\n', 0],
    ['cat <<EOF>/hs; cat /hs\nhi\nEOF', 'hi\n', 0],
    ['cat <<EOF|wc -l\nhi\nEOF', '1\n', 0],
    ['cat <<EOF&&echo x\nhi\nEOF', 'hi\nx\n', 0],
    ["cat <<'EOF'; echo x\nhi $HOME\nEOF", 'hi $HOME\nx\n', 0],
    ['cat <<A && cat <<B\na\nA\nb\nB', 'a\nb\n', 0],
    ['cat <<A | cat <<B\na\nA\nb\nB', 'b\n', 0],
    ['cat <<A || cat <<B\na\nA\nb\nB', 'a\n', 0],
    ['false <<A || cat <<B\na\nA\nb\nB', 'b\n', 0],
    ['cat <<A; cat <<B\na\nA\nb\nB', 'a\nb\n', 0],
    ['cat <<A && cat <<B; echo c\na\nA\nb\nB', 'a\nb\nc\n', 0],
    ['cat <<A && false <<B || echo no\na\nA\nb\nB', 'a\nno\n', 0],
    ['cat <<A | tr a-z A-Z <<B; echo z\na\nA\nb\nB', 'B\nz\n', 0],
    ['echo a; cat <<E1 | cat <<E2; echo z\n1\nE1\n2\nE2', 'a\n2\nz\n', 0],
    ['cat <<A && cat <<B\n\na\nA\n\nb\nB', '\na\n\nb\n', 0],
    ['(cat <<EOF)\nhi\nEOF', 'hi\n', 0],
    ['{ cat <<EOF; }\nhi\nEOF', 'hi\n', 0],
    ['if true; then cat <<EOF; fi\nhi\nEOF', 'hi\n', 0],
    ['case x in x) cat <<EOF;; esac\nhi\nEOF', 'hi\n', 0],
    ['cat <<EOF; # comment\nhi\nEOF', 'hi\n', 0],
    ['cat <<-EOF; echo x\n\thi\n\tEOF', 'hi\nx\n', 0],
    ['true; cat <<EOF; echo x\nhi\nEOF', 'hi\nx\n', 0],
    ['cat <<EOF; cat <<EOF\na\nEOF\nb\nEOF', 'a\nb\n', 0],
    ['cat <<EOF; echo x; echo y\nhi\nEOF', 'hi\nx\ny\n', 0],
    ['for i in 1 2; do cat <<EOF; done\n$i\nEOF', '1\n2\n', 0],
    ['f() { cat <<EOF; }; f; f\nhi\nEOF', 'hi\nhi\n', 0],
    ['while read l; do echo "[$l]"; done <<EOF; echo done\na\nb\nEOF', '[a]\n[b]\ndone\n', 0],
    ['false <<EOF; echo $?\nEOF', '1\n', 0],
    ['cat <<EOF; echo x\n  hi\nEOF', '  hi\nx\n', 0],
    ['cat <<EOF;\nhi\nEOF', 'hi\n', 0],
    ['cat <<EOF; case y in y) echo z;; esac\nhi\nEOF', 'hi\nz\n', 0],
    ['cat <<EOF; for ((i=0;i<2;i++)); do echo $i; done\nhi\nEOF', 'hi\n0\n1\n', 0],
    ['x=1; cat <<EOF; echo $x\n$x\nEOF', '1\n1\n', 0],
  ])('%j', async (line, stdout, exit) => {
    const { ws } = await makeWorkspace()
    try {
      const io = await ws.shell(line)
      expect([stdoutStr(io), io.exitCode]).toEqual([stdout, exit])
      expect(stderrStr(io)).toBe('')
    } finally {
      await ws.close()
    }
  })
})

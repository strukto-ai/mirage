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
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Direct port of tests/shell/test_quoting_coverage.py.
// Each test is one realistic agent pattern — failures surface as parser,
// classifier (TEXT vs PATH), or expansion-time bugs.

const ENC = new TextEncoder()

async function makeQuotingWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  ram.store.files.set('/plain.txt', ENC.encode('plain content\n'))
  ram.store.files.set('/my folder/note.txt', ENC.encode('in spaced folder\n'))
  ram.store.files.set('/my folder/My File.txt', ENC.encode('camelcase with space\n'))
  ram.store.files.set("/file's copy.txt", ENC.encode('with apostrophe\n'))
  ram.store.files.set('/数据/中文.txt', ENC.encode('unicode path content\n'))
  ram.store.dirs.add('/my folder')
  ram.store.dirs.add('/数据')

  const registry = new OpsRegistry()
  registry.registerResource(ram)

  const ws = new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.getSession(ws.defaultSessionId).cwd = '/data'
  return ws
}

async function run(ws: Workspace, cmd: string): Promise<{ out: string; exit: number }> {
  const io = await ws.execute(cmd)
  return { out: stdoutStr(io), exit: io.exitCode }
}

describe('shell quoting coverage (port of tests/shell/test_quoting_coverage.py)', () => {
  describe('paths with spaces', () => {
    it('single-quoted path with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "cat '/data/my folder/note.txt'")
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('double-quoted path with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat "/data/my folder/note.txt"')
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('ls directory with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "ls '/data/my folder/'")
      expect(r.out).toContain('note.txt')
      await ws.close()
    })

    it('find name pattern with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "find /data -name 'My File.txt'")
      expect(r.out).toContain('My File.txt')
      await ws.close()
    })
  })

  describe('paths with special chars', () => {
    it('double-quoted path with apostrophe inside', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat "/data/file\'s copy.txt"')
      expect(r.out).toBe('with apostrophe\n')
      await ws.close()
    })
  })

  describe('unicode in paths', () => {
    it('unicode path', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "cat '/data/数据/中文.txt'")
      expect(r.out).toBe('unicode path content\n')
      await ws.close()
    })

    it('unicode directory listing', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'ls /data/数据/')
      expect(r.out).toContain('中文.txt')
      await ws.close()
    })
  })

  describe('env vars in paths', () => {
    it('env var in double-quoted path expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, 'cat "$DIR/plain.txt"')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('braced env var in double-quoted path expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, 'cat "${DIR}/plain.txt"')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('env var in single-quoted path is literal (no expansion)', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, "cat '$DIR/plain.txt'")
      // File doesn't literally exist → non-zero exit OR empty stdout.
      expect(r.exit !== 0 || r.out === '').toBe(true)
      await ws.close()
    })
  })

  describe('command substitution in args', () => {
    it('command sub produces a path used by cat', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('echo /data/plain.txt > /data/path.txt')
      const r = await run(ws, 'cat $(cat /data/path.txt)')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('command sub in grep pattern', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('echo plain > /data/needle.txt')
      const r = await run(ws, 'grep "$(cat /data/needle.txt)" /data/plain.txt')
      expect(r.out).toContain('plain content')
      await ws.close()
    })
  })

  describe('escaping', () => {
    it('escaped dollar in double quotes is literal $PATH', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo "\\$PATH"')
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it("single-quoted '$PATH' is literal", async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "echo '$PATH'")
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it('double-quoted "$X" expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export X=hello')
      const r = await run(ws, 'echo "$X"')
      expect(r.out.trim()).toBe('hello')
      await ws.close()
    })
  })

  describe('unquoted backslash escapes (POSIX §2.2.1)', () => {
    it("close-escape-open: echo 'a'\\''b' → a'b", async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "echo 'a'\\''b'")
      expect(r.out.trim()).toBe("a'b")
      await ws.close()
    })

    it('escaped space in path: cat /data/my\\ folder/note.txt', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat /data/my\\ folder/note.txt')
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('unquoted \\$ is literal $: echo \\$PATH', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo \\$PATH')
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it('unquoted \\\\ is one backslash: echo \\\\', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo \\\\')
      expect(r.out).toBe('\\\n')
      await ws.close()
    })

    it('unquoted \\n is literal n: echo foo\\nbar', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo foo\\nbar')
      expect(r.out.trim()).toBe('foonbar')
      await ws.close()
    })
  })

  describe('edge cases', () => {
    it('empty string arg', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo ""')
      expect(r.out).toBe('\n')
      await ws.close()
    })

    it('consecutive quoted strings concatenate', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo "a""b"')
      expect(r.out.trim()).toBe('ab')
      await ws.close()
    })

    it('grep pattern with escaped embedded quote', async () => {
      const ws = await makeQuotingWs()
      const mount2 = ws.mount('/data/')
      if (mount2 === null) throw new Error('/data/ mount missing')
      const ws2Ram = mount2.resource as RAMResource
      ws2Ram.store.files.set('/quote.txt', ENC.encode('she said "hi"\n'))
      const r = await run(ws, 'grep "she said \\"hi\\"" /data/quote.txt')
      expect(r.out).toContain('hi')
      await ws.close()
    })
  })

  describe('echo quoting matrix (parametrized in Python)', () => {
    const cases: [string, string][] = [
      ['hello world', 'hello world\n'],
      ["'inner'", "'inner'\n"],
      ['$NONEXISTENT', '\n'],
    ]
    for (const [input, expected] of cases) {
      it(`echo "${input}" → ${JSON.stringify(expected)}`, async () => {
        const ws = await makeQuotingWs()
        const r = await run(ws, `echo "${input}"`)
        expect(r.out).toBe(expected)
        await ws.close()
      })
    }
  })
  describe('whitespace between expansions inside double quotes', () => {
    // tree-sitter folds the separating whitespace into the *second*
    // node's extent, so each expansion branch has to re-emit it.
    const cases: [string, string][] = [
      ['echo "$(echo a) $(echo b)"', 'a b\n'],
      ['echo "$(echo a) $(echo b) $(echo c)"', 'a b c\n'],
      ['x=a; echo "$x $(echo b)"', 'a b\n'],
      ['x=a; echo "${x} $(echo b)"', 'a b\n'],
      ['y=b; echo "$(echo a) ${y}"', 'a b\n'],
      ['echo "$((1+1)) $(echo b)"', '2 b\n'],
      ['echo "$(echo a) $((1+1))"', 'a 2\n'],
      ['echo "$((1+1)) $((2+2))"', '2 4\n'],
      ['x=a; echo "$x $((1+1))"', 'a 2\n'],
      ['x=a; true; echo "$x $?"', 'a 0\n'],
      ['x=a; set -- p q; echo "$x $#"', 'a 2\n'],
      // a run of whitespace is preserved verbatim, not collapsed
      ['echo "$(echo a)  $(echo b)"', 'a  b\n'],
      ['printf "%s\\n" "$(echo a)\t$(echo b)"', 'a\tb\n'],
      // unquoted words never fold, so word splitting is unchanged
      ['echo $(echo a) $(echo b)', 'a b\n'],
      ['echo $((1+1)) $((2+2))', '2 4\n'],
      // "${a[@]}" word-splits, and the folded gap joins its first word
      ['x=a; arr=(1 2); echo "$x ${arr[@]}"', 'a 1 2\n'],
      ['arr=(1 2); echo "$(echo p) ${arr[@]}"', 'p 1 2\n'],
      ['arr=(1 2); echo "${arr[@]} ${arr[@]}"', '1 2 1 2\n'],
      ['x=a; arr=(); echo "[$x ${arr[@]}]"', '[a ]\n'],
    ]
    for (const [line, expected] of cases) {
      it(`${line} \u2192 ${JSON.stringify(expected)}`, async () => {
        const ws = await makeQuotingWs()
        const r = await run(ws, line)
        expect(r.out).toBe(expected)
        await ws.close()
      })
    }
  })
  describe('adjacent backtick substitutions', () => {
    // tree-sitter merges pairs separated by nothing or whitespace into
    // one node, so the region is re-lexed during expansion.
    const cases: [string, string][] = [
      ['echo `echo a` `echo b`', 'a b\n'],
      ['echo "`echo a` `echo b`"', 'a b\n'],
      ['echo `echo a``echo b`', 'ab\n'],
      ['echo "`echo a``echo b`"', 'ab\n'],
      ['echo `echo a` `echo b` `echo c`', 'a b c\n'],
      ['echo "`echo \'q q\'` `echo b`"', 'q q b\n'],
      // backslash parity: `\\` is one escaped backslash, so the
      // backtick after it still closes the region
      ["echo `echo 'a\\\\'`", 'a\\\n'],
      ["echo `echo 'a\\\\'` `echo b`", 'a\\ b\n'],
      ["echo `echo 'a\\\\b'`", 'a\\b\n'],
      ["echo `echo 'a\\`b'`", 'a`b\n'],
      ['echo `echo \\`echo n\\``', 'n\n'],
      // shapes the grammar already handled, kept so the re-lex is
      // proven not to regress them
      ['echo `echo a`', 'a\n'],
      ['echo "`echo a`"', 'a\n'],
      ['echo "x`echo a`y`echo b`z"', 'xaybz\n'],
      ['echo "`echo a` lit `echo b`"', 'a lit b\n'],
      ['echo `echo a` mid `echo b`', 'a mid b\n'],
      ['x=`echo a`; y=`echo b`; echo "$x $y"', 'a b\n'],
    ]
    for (const [line, expected] of cases) {
      it(`${line} \u2192 ${JSON.stringify(expected)}`, async () => {
        const ws = await makeQuotingWs()
        const r = await run(ws, line)
        expect(r.out).toBe(expected)
        await ws.close()
      })
    }
  })
  describe('line continuation and unterminated backticks', () => {
    it.each([
      // A trailing backslash continues the line; with nothing to
      // continue onto, bash drops it and runs the command.
      ['echo a\\', 'a\n'],
      ['echo \\', '\n'],
      ['echo a\\\\', 'a\\\n'],
      ['echo `echo a\\\\`', 'a\n'],
    ])('%j -> %j', async (line, expected) => {
      const ws = await makeQuotingWs()
      const r = await run(ws, line)
      expect(r.exit).toBe(0)
      expect(r.out).toBe(expected)
      await ws.close()
    })

    it.each(['echo `echo a', 'echo "`echo \'`\'`"'])(
      'exits 2 on the unterminated backtick in %j',
      async (line) => {
        const ws = await makeQuotingWs()
        const r = await run(ws, line)
        expect(r.exit).toBe(2)
        await ws.close()
      },
    )
  })
})

describe('ANSI-C quoting $\'...\' and locale quoting $"..."', () => {
  // Expectations pinned against bash 5.2 (docker, C.UTF-8); direct port
  // of the matching block in tests/shell/test_quoting_coverage.py.
  it.each([
    ["echo $'a\\nb'", 'a\nb\n'],
    ["echo x$'\\ty'z", 'x\tyz\n'],
    ["echo $'\\x41\\101\\u42\\U00000043'", 'AABC\n'],
    ["echo $'a\\qb'", 'a\\qb\n'],
    ["echo $'\\x'", '\\x\n'],
    ["echo $'it\\'s'", "it's\n"],
    ["echo $'' y", ' y\n'],
    // NUL truncates the segment alone, not the rest of the word
    ["printf '[%s]' x$'a\\0b'y", '[xay]'],
    // braces inside the quotes are literal, outside still expand
    ["echo $'{a,b}'", '{a,b}\n'],
    ["echo $'a'{1,2}", 'a1 a2\n'],
    // no expansion of any kind happens inside
    ["V=w; echo $'$V $(echo x)'", '$V $(echo x)\n'],
    // assignments and quoted re-reads round-trip
    ['V=$\'x\\ty\'; echo "$V"', 'x\ty\n'],
    // inside double quotes the form is inert text
    ['echo "$\'a\\nb\'"', "$'a\\nb'\n"],
    // $"..." is plain double-quote semantics (identity translation)
    ['echo $"hello world"', 'hello world\n'],
    ['echo a$"b c"d', 'ab cd\n'],
    ['echo "a"$"c"', 'ac\n'],
    ['V=$"tv"; echo "$V"', 'tv\n'],
    // a bare trailing dollar is still literal text
    ['echo a$', 'a$\n'],
  ])('expands %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })

  it('keeps the quoted form one word across spaces', async () => {
    const ws = await makeQuotingWs()
    const r = await run(ws, 'for i in $\'x y\'; do echo "<$i>"; done')
    expect(r.out).toBe('<x y>\n')
    await ws.close()
  })

  it('names a redirect target through the decoded text', async () => {
    const ws = await makeQuotingWs()
    await run(ws, "echo hi > $'f 1.txt'")
    const r = await run(ws, "cat '/data/f 1.txt'")
    expect(r.out).toBe('hi\n')
    await ws.close()
  })

  it('carries the decoded text through a herestring', async () => {
    const ws = await makeQuotingWs()
    const r = await run(ws, "grep -c $'\\t' <<< $'a\\tb'")
    expect(r.out).toBe('1\n')
    await ws.close()
  })

  it('treats the quoted form as literal in a test command', async () => {
    const ws = await makeQuotingWs()
    const r = await run(ws, "x=a; [[ $x == $'a' ]] && echo eq")
    expect(r.out).toBe('eq\n')
    await ws.close()
  })

  it('emits high bytes as raw output bytes', async () => {
    const ws = await makeQuotingWs()
    const io = await ws.execute("echo $'\\xe4\\xb8\\xad'")
    expect(stdoutStr(io)).toBe('中\n')
    await ws.close()
  })
})

describe('quoted case patterns (pinned against bash 5.2 in docker)', () => {
  it.each([
    ["case a in 'a') echo hit;; *) echo miss;; esac", 'hit\n'],
    ['case a in "a") echo hit;; *) echo miss;; esac', 'hit\n'],
    ["case a in $'a') echo hit;; *) echo miss;; esac", 'hit\n'],
    ['case a in $"a") echo hit;; *) echo miss;; esac', 'hit\n'],
    // A quoted glob is literal; an unquoted one stays live.
    ["case '*' in '*') echo hit;; *) echo other;; esac", 'hit\n'],
    ["case x in '*') echo lit;; *) echo glob;; esac", 'glob\n'],
    // Expansion results are live patterns unless double-quoted.
    ['x=\'*\'; case y in "$x") echo lit;; *) echo miss;; esac', 'miss\n'],
    ["x='*'; case '*' in \"$x\") echo hit;; *) echo miss;; esac", 'hit\n'],
    ["x='*'; case y in $x) echo glob;; *) echo miss;; esac", 'glob\n'],
    // Patterns are never word-split.
    ["p='a b'; case 'a b' in $p) echo hit;; *) echo miss;; esac", 'hit\n'],
    // Concatenations mix literal and live segments.
    ["case ab in 'a'*) echo hit;; *) echo miss;; esac", 'hit\n'],
    ["case Xb in 'a'*) echo hit;; *) echo miss;; esac", 'miss\n'],
    ['case ab in a"b") echo hit;; *) echo miss;; esac', 'hit\n'],
    // Backslash escapes the next character in an unquoted pattern.
    ["case 'a*b' in a\\*b) echo hit;; *) echo miss;; esac", 'hit\n'],
    ['case aXb in a\\*b) echo hit;; *) echo miss;; esac', 'miss\n'],
    ['case x in \\?) echo hit;; *) echo miss;; esac', 'miss\n'],
    // Escaped-quote coverage: literal class text and quoted alternation.
    ["case '[^a]' in '[^a]') echo hit;; *) echo miss;; esac", 'hit\n'],
    ['case b in [^a]) echo hit;; *) echo miss;; esac', 'hit\n'],
    ["case b in a|'b') echo hit;; *) echo miss;; esac", 'hit\n'],
    ["case '' in '') echo hit;; *) echo miss;; esac", 'hit\n'],
  ])('matches %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })

  it('matches decoded ANSI-C bytes in a pattern', async () => {
    const ws = await makeQuotingWs()
    const r = await run(ws, "case \"$(printf 'a\\tb')\" in $'a\\tb') echo hit;; esac")
    expect(r.out).toBe('hit\n')
    await ws.close()
  })
})

describe('quoted declaration operands (pinned against bash 5.2)', () => {
  it.each([
    ["export 'FOO=bar'; echo [$FOO]", '[bar]\n'],
    ['x=v; export "FOO=$x"; echo [$FOO]', '[v]\n'],
    ["export 'A=1' B=2; echo [$A][$B]", '[1][2]\n'],
    ["export $'T=a\\tb'; printf '[%s]\\n' \"$T\"", '[a\tb]\n'],
    ["export 'NOEQ'; echo ok$?", 'ok0\n'],
    ["declare 'x=y z'; echo [$x]", '[y z]\n'],
    // Quoting keeps a compound-looking value scalar, exactly like bash.
    ["declare 'x=(1 2)'; echo [$x] [${x[1]-unset}]", '[(1 2)] [unset]\n'],
    ["f() { local 'l=v'; echo in:[$l]; }; f; echo out:[$l]", 'in:[v]\nout:[]\n'],
    ["readonly 'R=v'; echo [$R]", '[v]\n'],
  ])('assigns %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })
})

describe('quoted parameter-expansion and [[ ]] patterns (pinned against bash 5.2 in docker)', () => {
  it.each([
    // Quoted parameter-expansion patterns match literally.
    ['v="a*b"; echo "${v#"a*"}"', 'b\n'],
    ['v=aXb; echo "${v#"a*"}"', 'aXb\n'],
    ['v=aXb; echo "${v#\'a*\'}"', 'aXb\n'],
    ['v="a*b"; echo "${v/"*"/y}"', 'ayb\n'],
    ['v="a*b"; echo "${v%"*b"}"', 'a\n'],
    ['v=aXbXc; echo "${v//"X"/-}"', 'a-b-c\n'],
    // Unquoted globs stay live; a backslash binds the next char.
    ['v=aXb; echo ${v#a*}', 'Xb\n'],
    ['v="a*b"; echo ${v#a\\*}', 'b\n'],
    ['v=aXb; echo ${v#a\\*}', 'aXb\n'],
    // Expansion values are live unquoted, literal double-quoted.
    ['p=\'a*\'; v=\'a*b\'; echo "${v#"$p"}"', 'b\n'],
    ["p='a*'; v='a*b'; echo ${v#$p}", '*b\n'],
    ["v=$'a\\tb'; echo \"${v#$'a\\t'}\"", 'b\n'],
    // Mixed operands stay one opaque token; quoting inside them
    // still binds (single, double, ANSI-C, quoted refs).
    ['v=ab; echo "[${v#a\'b\'}]"', '[]\n'],
    ['v="xa*b"; echo "[${v#x"a*"}]"', '[b]\n'],
    ['v=xaXb; echo "[${v#x"a*"}]"', '[xaXb]\n'],
    ['v=xy; echo "[${v#$\'x\'y}]"', '[]\n'],
    ['p=\'a*\'; v=\'xa*b\'; echo "[${v#x"$p"}]"', '[b]\n'],
    ['p=\'a*\'; v=xaXb; echo "[${v#x$p}]"', '[Xb]\n'],
    // [[ == ]] renders its right side through the same expander.
    ['x=abc; [[ $x == "a*"* ]] && echo hit || echo miss', 'miss\n'],
    ['x=\'a*c\'; [[ $x == "a*"* ]] && echo hit || echo miss', 'hit\n'],
    ['x=aXb; [[ $x == "a"*"b" ]] && echo hit || echo miss', 'hit\n'],
    ['x=ab; [[ $x == "a*" ]] && echo hit || echo miss', 'miss\n'],
    ['x=ab; [[ $x == a* ]] && echo hit || echo miss', 'hit\n'],
    ['x=ab; [[ $x != "a*" ]] && echo hit || echo miss', 'hit\n'],
    ["x=$'a\\tb'; [[ $x == $'a\\tb' ]] && echo hit || echo miss", 'hit\n'],
    ['[[ abc < abd ]] && echo hit || echo miss', 'hit\n'],
  ])('matches %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })
})

describe('multi-line double-quoted strings (pinned against bash 5.2 in docker)', () => {
  it.each([
    ['echo "a\nb"', 'a\nb\n'],
    ['echo "a\n\nb"', 'a\n\nb\n'],
    ['echo "\na"', '\na\n'],
    ['echo "a\n"', 'a\n\n'],
    ['x=1; echo "p$x\n\nq"', 'p1\n\nq\n'],
    ['case "a\nb" in "a\nb") echo hit;; *) echo miss;; esac', 'hit\n'],
  ])('keeps the newlines of %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })
})

describe('a bare $ is a literal word', () => {
  it.each([
    ['echo $', '$\n'],
    ['echo a$ b', 'a$ b\n'],
    ['echo $ x', '$ x\n'],
    // Adjacency decides: $"..." is a translated string, $ "..." is two words.
    ['echo $"x"', 'x\n'],
    ['echo $ "x"', '$ x\n'],
  ])('prints %j', async (line, expected) => {
    const ws = await makeQuotingWs()
    const r = await run(ws, line)
    expect(r.out).toBe(expected)
    await ws.close()
  })
})

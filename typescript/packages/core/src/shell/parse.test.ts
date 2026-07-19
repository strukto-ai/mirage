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
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { createShellParser, findSyntaxError, type ShellParser } from './parse.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('createShellParser', () => {
  it('parses a simple command to a program root with a command child', () => {
    const root = parser.parse('echo hello')
    expect(root.type).toBe('program')
    expect(root.childCount).toBeGreaterThan(0)
    const command = root.child(0)
    expect(command?.type).toBe('command')
  })

  it('parses a pipeline to a program with a pipeline child', () => {
    const root = parser.parse('echo hello | grep world')
    expect(root.type).toBe('program')
    const pipeline = root.child(0)
    expect(pipeline?.type).toBe('pipeline')
  })

  it('parses a redirection', () => {
    const root = parser.parse('echo hi > /tmp/x.txt')
    expect(root.type).toBe('program')
    const stmt = root.child(0)
    expect(stmt?.type).toBe('redirected_statement')
  })

  it('exposes node text matching the source', () => {
    const root = parser.parse('cat /data/foo.txt')
    const command = root.child(0)
    expect(command?.text).toBe('cat /data/foo.txt')
  })

  it('returns the same parser interface across multiple parse() calls', () => {
    const a = parser.parse('ls')
    const b = parser.parse('pwd')
    expect(a.type).toBe('program')
    expect(b.type).toBe('program')
    expect(a.child(0)?.text).toBe('ls')
    expect(b.child(0)?.text).toBe('pwd')
  })
})

describe('createShellParser — realistic multi-statement command', () => {
  // Mirrors a command run by a user against an R2 mount that surfaced an
  // OPFS getFileHandle error. We don't dispatch here — we just verify the
  // parser tokenizes the command into exactly the structure we expect, so a
  // future regression in shell parsing can't quietly reroute grep elsewhere.
  const SRC =
    "find /r2/Review -maxdepth 3 -type f | sed 's#^#FILE #'; echo '---'; grep -RIl \"Base3\\|base3\" /r2/Review || true"

  it('produces a program with three top-level statements', () => {
    const root = parser.parse(SRC)
    expect(root.type).toBe('program')
    expect(root.namedChildren).toHaveLength(3)
  })

  it('first statement is a pipeline of find | sed', () => {
    const root = parser.parse(SRC)
    const first = root.namedChildren[0]
    expect(first?.type).toBe('pipeline')
    const cmds = first?.namedChildren.filter((n) => n.type === 'command') ?? []
    expect(cmds).toHaveLength(2)
    expect(cmds[0]?.text.startsWith('find /r2/Review')).toBe(true)
    expect(cmds[1]?.text.startsWith('sed ')).toBe(true)
  })

  it('second statement is echo with a single-quoted arg', () => {
    const root = parser.parse(SRC)
    const second = root.namedChildren[1]
    expect(second?.type).toBe('command')
    expect(second?.text).toBe("echo '---'")
  })

  it('third statement is grep || true', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    expect(third?.type).toBe('list')
    const left = third?.namedChildren[0]
    expect(left?.type).toBe('command')
    expect(left?.text.startsWith('grep ')).toBe(true)
    expect(third?.text.includes('|| true')).toBe(true)
  })

  it('quoted regex "Base3\\|base3" stays a single argument', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    expect(grepCmd?.type).toBe('command')
    // collect argv-style children: (name) + word-like args
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    // Expect the regex appears as one element (with its surrounding quotes).
    const regexArg = argTexts.find((t) => t.includes('Base3'))
    expect(regexArg).toBe('"Base3\\|base3"')
  })

  it('grep target path /r2/Review parses as a single argument, no glob expansion at parse time', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    const pathArg = argTexts.find((t) => t === '/r2/Review')
    expect(pathArg).toBe('/r2/Review')
  })
})

describe('findSyntaxError', () => {
  it.each(['if then fi', 'echo (', 'for x do done', 'for', 'if', 'if; fi', 'echo "unterm'])(
    'flags structural syntax error in %j',
    (cmd) => {
      const root = parser.parse(cmd)
      expect(findSyntaxError(root)).not.toBeNull()
    },
  )

  it.each([
    'echo hi',
    'for x in a b; do echo $x; done',
    'if true; then echo y; fi',
    'cat /tmp/x | sort',
    "cat <<EN'D'\n$v\nEND",
    'echo bg &; echo fg',
    'for x in; do echo $x; done',
  ])('returns null for valid / recoverable %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).toBeNull()
  })
})

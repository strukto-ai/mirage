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
import { getParts, getRedirects, getText } from '../helpers.ts'
import { createShellParser, type ShellParser, stripLineContinuation } from './index.ts'
import type { TSNodeLike } from '../types.ts'

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

describe('(( reparse: subshell that immediately opens a subshell', () => {
  it('parses as nested subshells rather than an arithmetic command', () => {
    const root = parser.parse('((echo a); echo b)')
    expect(root.hasError).toBe(false)
    expect(root.namedChildren[0]?.type).toBe('subshell')
  })

  it('handles the backgrounded form', () => {
    expect(parser.parse('((echo s1; echo s2) & wait)').hasError).toBe(false)
  })

  it('leaves a genuine arithmetic command untouched', () => {
    expect(parser.parse('i=1; ((i++)); echo $i').hasError).toBe(false)
  })

  // Each opener is judged on its own span, not on the error region:
  // tree-sitter's ERROR swallows the valid `((i++))` next to the bad
  // opener, so scope alone would split both and silently turn the
  // arithmetic into a subshell running `i++`.
  it('handles a line mixing arithmetic and a nested subshell', () => {
    expect(parser.parse('i=1; ((i++)); ((echo x); echo $i)').hasError).toBe(false)
  })

  it('is not confused by a paren inside quotes', () => {
    expect(parser.parse('((echo ")"); echo b)').hasError).toBe(false)
  })

  it('handles two nested subshells on one line', () => {
    expect(parser.parse('((echo a); echo b); ((echo c); echo d)').hasError).toBe(false)
  })

  it('multibyte text before the opener does not shift offsets', () => {
    expect(parser.parse('echo é; ((echo a); echo b)').hasError).toBe(false)
  })

  it('still reports an unrelated syntax error', () => {
    expect(parser.parse('if then').hasError).toBe(true)
  })
})

// tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
// when the name is cut short by a name-terminating character: the `$`
// stays behind as a literal token and the rest splits into a sibling
// word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
// the orphaned expansion and reparses, so consumers see one whole word.
describe('$ reparse: later unbraced var cut off from its name', () => {
  it.each([
    ['echo hi > /api/$c/$id.json', '/api/$c/${id}.json'],
    ['echo hi > /api/$c/$id-x', '/api/$c/${id}-x'],
    ['echo hi > /w/$a/$b/$c', '/w/$a/${b}/$c'],
    ['echo hi > ${a}.$b.json', '${a}.${b}.json'],
    ['echo hi > /w/$c/$1.json', '/w/$c/${1}.json'],
  ])('keeps the redirect target of %j one word', (command, target) => {
    const statement = parser.parse(command).children[0] as TSNodeLike
    expect(statement.type).toBe('redirected_statement')
    const [, redirects] = getRedirects(statement)
    expect(redirects).toHaveLength(1)
    expect(redirects[0]?.target).toBe(target)
  })

  it('keeps a bare word one argument', () => {
    const command = parser.parse('echo /api/$c/$id.json').children[0] as TSNodeLike
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '/api/$c/${id}.json'])
  })

  it('keeps an assignment one assignment', () => {
    // The broken parse split this into an assignment holding
    // `p=/api/$c/$` plus a command named `id.json`.
    const node = parser.parse('p=/api/$c/$id.json').namedChildren[0]
    expect(node?.type).toBe('variable_assignment')
    expect(getText(node as TSNodeLike)).toBe('p=/api/$c/${id}.json')
  })

  it.each([
    // A `$` bash keeps literal is left alone: no name character follows.
    ['echo a$ b', ['echo', 'a$', 'b']],
    ['echo $', ['echo', '$']],
  ])('leaves the literal dollar in %j untouched', (command, words) => {
    const node = parser.parse(command).children[0] as TSNodeLike
    expect(getParts(node).map((p) => getText(p))).toEqual(words)
  })
})

describe('stripLineContinuation', () => {
  it.each([
    // An odd-length trailing run ends in a live continuation.
    ['echo a\\', 'echo a'],
    ['echo a\\\\\\', 'echo a\\\\'],
    ['echo \\', 'echo '],
    // An even-length run is all escaped backslashes, so nothing goes.
    ['echo a\\\\', 'echo a\\\\'],
    ['echo a', 'echo a'],
    ['echo a\\ b', 'echo a\\ b'],
  ])('%j -> %j', (command, expected) => {
    expect(stripLineContinuation(command)).toBe(expected)
  })
})

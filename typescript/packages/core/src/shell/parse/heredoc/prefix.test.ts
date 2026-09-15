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
import { Language, Parser } from 'web-tree-sitter'
import type { TSNodeLike } from '../../types.ts'
import { protectedSource } from './shield.ts'
import type { Node } from 'web-tree-sitter'
import { bodyPrefix, treeRoot } from './prefix.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

const HEREDOC_REDIRECT = 'heredoc_redirect'

let shielding: { parse(command: string): Node }
let plain: Parser

beforeAll(async () => {
  await Parser.init({ wasmBinary: engineWasm })
  const language = await Language.load(new Uint8Array(grammarWasm))
  plain = new Parser()
  plain.setLanguage(language)
  shielding = {
    parse(command) {
      const raw = plain.parse(command)
      if (raw === null) throw new Error('no tree')
      const source = protectedSource(command, raw.rootNode)
      if (source === null) return raw.rootNode
      const shielded = plain.parse(source)
      if (shielded === null || shielded.rootNode.hasError) return raw.rootNode
      return plain.parse(command, shielded)?.rootNode ?? raw.rootNode
    },
  }
})

function redirects(root: TSNodeLike): TSNodeLike[] {
  const found: TSNodeLike[] = []
  const stack: TSNodeLike[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === HEREDOC_REDIRECT) found.push(node)
    stack.push(...node.children)
  }
  if (found.length === 0) throw new Error('no heredoc_redirect in the tree')
  return found.sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))
}

function prefix(command: string): string {
  const [first] = redirects(shielding.parse(command) as TSNodeLike)
  if (first === undefined) throw new Error('no heredoc_redirect in the tree')
  return bodyPrefix(first)
}

// Two heredocs on one line, laid out as the parser's source keeps them:
// innermost-first (see relayout), so B's body precedes A's.
const TWO_ON_A_LINE = 'cat <<A <<B\nb\nB\n\na\nA\n'

// The slice of a web-tree-sitter Node that bodyPrefix reads, over
// TWO_ON_A_LINE.
function node(type: string, start: number, end: number, children: TSNodeLike[] = []): TSNodeLike {
  const built: TSNodeLike = {
    type,
    text: TWO_ON_A_LINE.slice(start, end),
    children,
    namedChildren: children,
    startIndex: start,
    endIndex: end,
    parent: null,
  }
  let previous: TSNodeLike | null = null
  for (const child of children) {
    child.parent = built
    child.previousSibling = previous
    previous = child
  }
  return built
}

// A redirect of TWO_ON_A_LINE: `<<` at `operator`, a one-letter delimiter,
// and a one-letter body line at `body`.
function heredoc(operator: number, body: number): TSNodeLike {
  return node(HEREDOC_REDIRECT, operator, body + 3, [
    node('<<', operator, operator + 2),
    node('heredoc_start', operator + 2, operator + 3),
    node('heredoc_body', body, body + 2),
    node('heredoc_end', body + 2, body + 3),
  ])
}

describe('bodyPrefix', () => {
  it('is empty when the node starts the body', () => {
    expect(prefix('cat <<EOF\nfoo\nEOF\n')).toBe('')
  })

  it('is the leading empty line', () => {
    expect(prefix('cat <<EOF\n\nfoo\nEOF\n')).toBe('\n')
  })

  it('is every leading empty line', () => {
    expect(prefix('cat <<EOF\n\n\nfoo\nEOF\n')).toBe('\n\n')
  })

  it('precedes a backslash line', () => {
    expect(prefix('cat <<EOF\n\n\\first\nEOF\n')).toBe('\n')
  })

  it('is the whole body when that is one empty line', () => {
    expect(prefix('cat <<EOF\n\nEOF\n')).toBe('\n')
  })

  it('follows a pipeline on the operator line', () => {
    expect(prefix('cat <<EOF | tr a-z A-Z\n\nfoo\nEOF\n')).toBe('\n')
  })

  it('follows a comment on the operator line', () => {
    expect(prefix("cat <<EOF # don't\n\nfoo\nEOF\n")).toBe('\n')
  })

  it('follows a file redirect', () => {
    expect(prefix('cat > /data/x <<EOF\n\nfoo\nEOF\n')).toBe('\n')
  })

  it('works under <<-', () => {
    expect(prefix('cat <<-EOF\n\n\tfoo\nEOF\n')).toBe('\n')
  })

  it('leaves a blank first line to the body', () => {
    expect(prefix('cat <<EOF\n  \nfoo\nEOF\n')).toBe('')
  })

  it('is the indentation an unshielded tree skipped', () => {
    const cmd = 'cat <<EOF\n  foo\nEOF\n'
    const tree = plain.parse(cmd)
    if (tree === null) throw new Error('parse returned null')
    const [first] = redirects(tree.rootNode as TSNodeLike)
    if (first === undefined) throw new Error('no heredoc_redirect in the tree')
    expect(bodyPrefix(first)).toBe('  ')
  })

  it('reads the source from a root that sits past leading blanks', () => {
    expect(prefix('  cat <<EOF\n\nfoo\nEOF\n')).toBe('\n')
    expect(prefix('\n\ncat <<EOF\n\nfoo\nEOF\n')).toBe('\n')
  })

  it('keeps the blank line of an unterminated body', () => {
    // Bash reads the body to the end of the input, blank lines included.
    expect(prefix('cat <<EOF\n\nfoo\n')).toBe('\n')
  })

  it('reads a heredoc inside a command substitution on its own line', () => {
    const [outer, inner] = redirects(
      shielding.parse('cat <<A $(cat <<B\n\nb\nB\n)\na\nA\n') as TSNodeLike,
    )
    if (outer === undefined || inner === undefined) throw new Error('expected two redirects')
    expect(bodyPrefix(outer)).toBe('')
    expect(bodyPrefix(inner)).toBe('\n')
  })

  it('measures an earlier heredoc on the line from the line after the later body', () => {
    // tree-sitter-bash has no tree for two heredocs on one command; were
    // it to grow one, the line's bodies would stand innermost-first as
    // relayout writes them, so B's body follows the operator line and A's
    // blank line is measured from the line after B's terminator, not from
    // the operator line's newline the two share.
    const first = heredoc(4, 17)
    const second = heredoc(8, 12)
    const root = node('program', 0, TWO_ON_A_LINE.length, [
      node('redirected_statement', 0, 20, [node('command', 0, 3), first, second]),
    ])
    expect(treeRoot(second)).toBe(root)
    expect(bodyPrefix(second)).toBe('')
    expect(bodyPrefix(first)).toBe('\n')
  })
})

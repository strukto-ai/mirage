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
import { type Ask, parseShell, Shell, type ShellTask, type ShellTreeNode } from './shell.ts'

// Mirrors Python's BASH.
const BASH: [string, string][] = [
  [
    'exec 0>f',
    '(program (redirected_statement body: (command name: (command_name (word))) redirect: (file_redirect descriptor: (file_descriptor) destination: (word))))',
  ],
  [
    'time a | b',
    '(program (timed_statement (pipeline (command name: (command_name (word))) (command name: (command_name (word))))))',
  ],
  [
    '! { a; }',
    '(program (negated_command (compound_statement (command name: (command_name (word))))))',
  ],
  [
    'echo $10',
    '(program (command name: (command_name (word)) argument: (concatenation (simple_expansion (variable_name)) (number))))',
  ],
]

function sexp(node: ShellTreeNode, field: string | null = null): string {
  const named = node.children.flatMap((child, i) =>
    child.isNamed ? [sexp(child, node.fieldNameForChild(i))] : [],
  )
  return `${field === null ? '' : `${field}: `}(${[node.type, ...named].join(' ')})`
}

describe('parseShell', () => {
  it.each(BASH)('reads as bash reads: %j', (line, want) => {
    const tree = parseShell(line)
    expect(tree.error).toBeNull()
    expect(sexp(tree.rootNode)).toBe(want)
  })

  it('reports a refused line in bash words', () => {
    const refusal = (line: string, extglob = true) => {
      const tree = parseShell(line, [], extglob)
      return [tree.error, tree.refusal('bash: -c: ', 1, true)]
    }
    expect(refusal('if true; then')).toEqual([
      { index: 13, status: 2 },
      'bash: -c: line 2: syntax error: unexpected end of file\n',
    ])
    expect(refusal('echo a; fi')).toEqual([
      { index: 8, status: 2 },
      "bash: -c: line 1: syntax error near unexpected token `fi'\nbash: -c: line 1: `echo a; fi'\n",
    ])
    // With extglob off a pattern group is no word.
    expect(parseShell('echo @(a)').error).toBeNull()
    expect(refusal('echo @(a)', false)).toEqual([
      { index: 6, status: 2 },
      "bash: -c: line 1: syntax error near unexpected token `('\nbash: -c: line 1: `echo @(a)'\n",
    ])
  })

  it('links nodes to their family', () => {
    const root = parseShell('a=1 echo hi > f').rootNode
    const statement = root.child(0)
    if (statement === null) throw new Error('no statement')
    const [command, redirect] = statement.children as [ShellTreeNode, ShellTreeNode]
    expect(statement.parent?.id).toBe(root.id)
    expect(root.parent).toBeNull()
    expect(command.nextSibling?.id).toBe(redirect.id)
    expect(redirect.previousSibling?.id).toBe(command.id)
    expect(redirect.nextSibling).toBeNull()
    expect(statement.childForFieldName('redirect')?.id).toBe(redirect.id)
    expect(statement.child(1)?.id).toBe(redirect.id)
    expect(statement.child(2)).toBeNull()
    expect(command.childForFieldName('name')?.text).toBe('echo')
    expect(command.namedChildren.map((node) => node.type)).toEqual([
      'variable_assignment',
      'command_name',
      'word',
    ])
    expect(command.fieldNameForChild(2)).toBe('argument')
  })

  it('rejects raw node reads after disposing its tree', () => {
    const tree = parseShell('echo hello')
    const root = tree.rootNode
    const child = root.children[0]
    if (child === undefined) throw new Error('no command')
    tree.dispose()
    tree.dispose()
    for (const node of [root, child]) {
      for (const read of [
        () => node.parent,
        () => node.text,
        () => node.children,
        () => node.id,
        () => node.offsets,
        () => node.inlined,
        () => node.error,
        () => node.rereadLines(),
        () => node.warnings('', 1),
        () => node.child(-1),
        () => node.childForFieldName('missing'),
      ])
        expect(read).toThrow('released')
    }
    expect(() => tree.rootNode).toThrow('released')
  })

  it('counts offsets and columns in UTF-16 units', () => {
    const line = 'echo é💡 x'
    const word = parseShell(line).rootNode.child(0)?.child(2)
    expect(word?.startIndex).toBe(line.length - 1)
    expect(word?.startPosition).toEqual({ row: 0, column: line.length - 1 })
    expect(word?.text).toBe('x')
  })

  it('gives each tree its own ids', () => {
    const one = parseShell('a').rootNode
    const two = parseShell('a').rootNode
    expect(one.id).not.toBe(two.id)
    expect(one.children[0]?.id).toBe(one.children[0]?.id)
  })
})

describe('the text a tree reads', () => {
  it.each([
    // bash -c keeps a backslash ending the input; one before a last newline
    // continues onto nothing.
    ['echo a\\', 'echo a\\'],
    ['echo a\\\\\\', 'echo a\\\\\\'],
    ['echo \\', 'echo \\'],
    ['echo a\\\n', 'echo a'],
    // An even-length run is all escaped backslashes, so nothing goes.
    ['echo a\\\\', 'echo a\\\\'],
    ['echo a\\\\\\\\', 'echo a\\\\\\\\'],
    ['echo a', 'echo a'],
    ['echo a\\ b', 'echo a\\ b'],
    // Mid-line, the pair goes wherever the reader sees it.
    ['echo a\\\nb', 'echo ab'],
    ['echo "a\\\nb"', 'echo "ab"'],
    ['echo $\\\n{x} $((1\\\n+2))', 'echo ${x} $((1+2))'],
    ['ec\\\nho a', 'echo a'],
    ['echo a\\\\\nb', 'echo a\\\\\nb'],
    ['echo a\\\\\\\nb', 'echo a\\\\b'],
    // Single-quoted and ANSI-C text and comments keep theirs.
    ["echo 'a\\\nb'", "echo 'a\\\nb'"],
    ["echo $'a\\\nb'", "echo $'a\\\nb'"],
    ['echo a # c \\\necho b', 'echo a # c \\\necho b'],
    ['echo "$(echo \'u\\\nv\')"', 'echo "$(echo \'u\\\nv\')"'],
    ['echo "it\'s a\\\nb"', 'echo "it\'s ab"'],
  ])('drops the continuations of %j', (command, expected) => {
    expect(parseShell(command).source).toBe(expected)
  })

  it('keeps a quoted heredoc body whole', () => {
    const tree = parseShell("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    expect(tree.source).toBe('cat <"a\\\\\nb\n" | tr a b\n')
    expect(tree.rootNode.sourceText).toBe("cat <<'E' | \\\ntr a b\na\\\nb\nE")
  })

  it('joins an unquoted heredoc body', () => {
    expect(parseShell('cat <<E | \\\ntr a b\na\\\nb $x\nE').source).toBe(
      'cat <"ab $x\n" | tr a b\n',
    )
  })

  it.each([
    ['continuation', 'echo A; \\\n fi'],
    ['expansion', 'echo /api/$c/$id.json; fi'],
    ['bang', '! echo A \\\n; fi'],
    ['time', 'time echo A \\\n; fi'],
    ['heredoc', 'cat <<E; fi\nbody\nE'],
  ])('points a %s node back into the line as typed', (_label, command) => {
    // The stray `fi` is where the parser refuses each line.
    const root = parseShell(command).rootNode
    const errors = root.children.filter((node) => node.type === 'ERROR')
    expect(errors).toHaveLength(1)
    const at = errors[0]?.startIndex ?? -1
    expect(root.offsets?.[at] ?? at).toBe(command.lastIndexOf('fi'))
  })
})

describe('Shell', () => {
  function run(task: ShellTask, answer: (ask: Ask) => void) {
    for (let ask = task.step(); ask !== null; ask = task.step()) answer(ask)
    return task.finish()
  }

  function word(line: string): ShellTreeNode {
    const command = parseShell(line).rootNode.child(0)
    const node = command?.childForFieldName('argument')
    if (node === null || node === undefined) throw new Error(`no argument in ${line}`)
    return node
  }

  it('reads only a plain decimal as a plain index', () => {
    const shell = Shell.create(() => 7)
    expect(shell.plainIndex(' 42\t')).toBe(42n)
    expect(shell.plainIndex('99999999999999999999999')).toBe(200376420520689663n)
    expect(shell.plainIndex('042')).toBeNull()
    expect(shell.plainIndex('4+2')).toBeNull()
    expect(shell.plainIndex(' ')).toBeNull()
    shell.close()
  })

  it('seeds a fresh generator from its own id source, a subshell too', () => {
    const drawn: number[] = []
    const source = (seed: number) => () => {
      drawn.push(seed)
      return seed
    }
    const first = Shell.create(source(12345))
    const second = Shell.create(source(999))
    expect(first.nextRandom()).not.toEqual(second.nextRandom())
    expect(drawn).toEqual([12345, 999])
    const child = first.subshell()
    child.nextRandom()
    expect(drawn).toEqual([12345, 999, 12345])
    for (const shell of [first, second, child]) shell.close()
  })

  it('reads and writes its records with no gate', () => {
    const shell = Shell.create(() => 7)
    shell.seed('x', 'a b')
    shell.seed('m', new Map([['k', 'v']]), true)
    shell.setAttr('x', 'x', true)
    expect(shell.get('x')).toEqual(['a b', 'x', null])
    expect(shell.visible('m')).toEqual([new Map([['k', 'v']]), 'A', null])
    expect(shell.exported()).toEqual([['x', 'a b']])
    expect(shell.has('m') && !shell.has('y')).toBe(true)
    shell.close()
  })

  it('sends its lists again after the engine refuses a frame', () => {
    const shell = Shell.create(() => 7)
    const frame = {
      positional: ['a', 'b'],
      calls: [],
      status: 0,
      pid: 1,
      lastJob: null,
      argv0: 'bash',
      options: new Map<string, boolean>(),
      shopts: new Map<string, boolean>(),
      envLimit: null,
      outside: 0,
      pipeStatus: [],
      functionNames: null,
      callLines: [],
      paren: false,
      memoryRoom: null,
      line: 1,
      bashPid: 1,
      voice: 'bash: ',
      errTrap: false,
    }
    shell.frame({ ...frame, status: 2 ** 40 })
    expect(() => shell.has('x')).toThrow('out of range')
    shell.frame(frame)
    const count = (): unknown =>
      run(shell.expand(word('echo $#'), 'fields'), () => {
        throw new Error('nothing to ask')
      })[0]
    expect(count()).toEqual(['ok', ['2']])
    shell.frame({ ...frame, positional: ['c'] })
    expect(() => shell.visibleNames('bogus' as 'scalar')).toThrow()
    shell.frame(frame)
    expect(count()).toEqual(['ok', ['2']])
    shell.close()
  })

  it('expands a word on its variables, asking the host for a substitution', () => {
    const shell = Shell.create(() => 7)
    shell.seed('x', 'a b')
    const asked: string[] = []
    const task = shell.expand(word('echo $x$(c)'), 'fields')
    const [result, diagnostics] = run(task, (ask) => {
      if (ask[0] !== 'substitute') throw new Error(ask[0])
      asked.push(ask[2])
      ask[1].close()
      const encoder = new TextEncoder()
      task.answerSubstituted(encoder.encode('c d\n'), encoder.encode('w\n'), 0)
    })
    expect(asked).toEqual(['c'])
    expect(result).toEqual(['ok', ['a', 'bc', 'd']])
    expect(diagnostics).toEqual([new TextEncoder().encode('w\n')])
  })

  it('lands a write at once, and refuses a hidden name', () => {
    const shell = Shell.create(() => 7)
    expect(shell.set('y', '1')).toEqual([['ok', 0n], []])
    expect(shell.get('y')).toEqual(['1', '', null])
    shell.hide(['z'], [])
    expect(shell.set('z', '2')).toEqual([['hidden', 'z'], []])
    expect(shell.get('z')).toBeNull()
  })

  it('refuses a read while a task holds the shell', () => {
    const shell = Shell.create(() => 7)
    const task = shell.expand(word('echo $(c)'), 'text')
    expect(task.step()?.[0]).toBe('substitute')
    expect(() => shell.get('x')).toThrow('the shell is running a task')
    task.answerFailed()
    const [result] = run(task, () => undefined)
    expect(result).toEqual(['host', 'the host failed'])
    expect(shell.get('x')).toBeNull()
  })
})

it.each([
  ['echo \ud800', 'echo �'],
  ['echo \udc00', 'echo �'],
  ['echo \udd00', 'echo �'],
  ['echo \udcff', 'echo \udcff'],
  ['echo 😀', 'echo 😀'],
])('preserves encoded source semantics for %j', (input, expected) => {
  const tree = parseShell(input)
  expect(tree.source).toBe(expected)
  expect(tree.rootNode.children[0]?.text).toBe(expected)
  expect(tree.rootNode.sourceText).toBe(input)
  tree.dispose()
})

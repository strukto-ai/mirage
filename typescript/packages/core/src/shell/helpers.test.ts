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
import type { TSNodeLike } from '../workspace/expand/variable.ts'
import {
  getCommandAssignments,
  getCommandName,
  getDeclarationAssignments,
  getDeclarationKeyword,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getProcessSubBody,
  getRedirects,
  getSubshellBody,
  getText,
  getTestArgv,
  getUnsetNames,
  getWhileParts,
} from './helpers.ts'
import { NodeType as NT, RedirectKind } from './types.ts'

function node(
  type: string,
  text = '',
  opts: { children?: TSNodeLike[]; namedChildren?: TSNodeLike[]; isNamed?: boolean } = {},
): TSNodeLike {
  return {
    type,
    text,
    children: opts.children ?? [],
    namedChildren: opts.namedChildren ?? opts.children?.filter((c) => c.isNamed !== false) ?? [],
    isNamed: opts.isNamed ?? true,
  }
}

describe('getText / getCommandName', () => {
  it('getText returns node.text', () => {
    expect(getText(node('word', 'hello'))).toBe('hello')
  })

  it('getCommandName picks the command_name child', () => {
    const n = node('command', 'ls /ram', {
      namedChildren: [node(NT.COMMAND_NAME, 'ls'), node(NT.WORD, '/ram')],
    })
    expect(getCommandName(n)).toBe('ls')
  })

  it('getCommandName returns empty when none', () => {
    expect(getCommandName(node('command'))).toBe('')
  })
})

describe('getParts', () => {
  it('includes normal named children', () => {
    const n = node('command', 'ls /ram', {
      namedChildren: [node(NT.COMMAND_NAME, 'ls'), node(NT.WORD, '/ram')],
    })
    expect(getParts(n).map((c) => c.text)).toEqual(['ls', '/ram'])
  })

  it('skips FILE_REDIRECT and HERESTRING_REDIRECT children', () => {
    const n = node('command', '', {
      namedChildren: [
        node(NT.COMMAND_NAME, 'echo'),
        node(NT.WORD, 'hi'),
        node(NT.FILE_REDIRECT, '>file'),
      ],
    })
    expect(getParts(n)).toHaveLength(2)
  })
})

describe('getProcessSubBody', () => {
  it('preserves the complete inner shell source', () => {
    expect(getProcessSubBody(node('process_substitution', '<(echo one; echo two)'))).toBe(
      'echo one; echo two',
    )
    expect(getProcessSubBody(node('process_substitution', '<(printf x | sort)'))).toBe(
      'printf x | sort',
    )
  })
})

describe('getRedirects herestring ordering', () => {
  const commandName = node(NT.COMMAND_NAME, 'cat')
  const inputWord = node(NT.WORD, 'input.txt')
  const hereWord = node(NT.WORD, 'here')
  const input = node(NT.FILE_REDIRECT, '< input.txt', {
    children: [node(NT.REDIRECT_IN, '<', { isNamed: false }), inputWord],
    namedChildren: [inputWord],
  })
  const herestring = node(NT.HERESTRING_REDIRECT, '<<< here', {
    children: [node(NT.HERESTRING_TOKEN, '<<<', { isNamed: false }), hereWord],
    namedChildren: [hereWord],
  })

  it('hoists a command-nested herestring before an outer file redirect', () => {
    const command = node(NT.COMMAND, 'cat <<< here', {
      namedChildren: [commandName, herestring],
    })
    const statement = node(NT.REDIRECTED_STATEMENT, 'cat <<< here < input.txt', {
      namedChildren: [command, input],
    })
    const [, redirects] = getRedirects(statement)
    expect(redirects.map((r) => r.kind)).toEqual([RedirectKind.HERESTRING, RedirectKind.STDIN])
  })

  it('recovers a herestring parsed as ERROR plus file redirect', () => {
    const command = node(NT.COMMAND, 'cat', { namedChildren: [commandName] })
    const recoveredHere = node(NT.FILE_REDIRECT, '< here', {
      children: [node(NT.REDIRECT_IN, '<', { isNamed: false }), hereWord],
      namedChildren: [hereWord],
    })
    const statement = node(NT.REDIRECTED_STATEMENT, 'cat < input.txt <<< here', {
      namedChildren: [command, input, node(NT.ERROR, '<<'), recoveredHere],
    })
    const [, redirects] = getRedirects(statement)
    expect(redirects.map((r) => r.kind)).toEqual([RedirectKind.STDIN, RedirectKind.HERESTRING])
    expect(redirects[1]?.target).toBe('here')
  })
})

describe('getPipelineCommands', () => {
  it('splits children into command nodes and stderr flags', () => {
    const n = node('pipeline', '', {
      children: [
        node('command', 'a', { isNamed: true }),
        node(NT.PIPE, '|', { isNamed: false }),
        node('command', 'b', { isNamed: true }),
        node(NT.PIPE_STDERR, '|&', { isNamed: false }),
        node('command', 'c', { isNamed: true }),
      ],
    })
    const [cmds, flags] = getPipelineCommands(n)
    expect(cmds).toHaveLength(3)
    expect(flags).toEqual([false, true])
  })
})

describe('getListParts', () => {
  it('extracts left + op + right with && / || / ;', () => {
    const left = node('command', 'a')
    const right = node('command', 'b')
    const n = node('list', '', {
      children: [left, node(NT.AND, '&&', { isNamed: false }), right],
      namedChildren: [left, right],
    })
    const [l, op, r] = getListParts(n)
    expect(l).toBe(left)
    expect(op).toBe('&&')
    expect(r).toBe(right)
  })
})

describe('getWhileParts / getSubshellBody', () => {
  it('while returns condition + body from do_group', () => {
    const cond = node('command', 'cond')
    const body1 = node('command', 'body1')
    const body2 = node('command', 'body2')
    const doGroup = node(NT.DO_GROUP, '', { namedChildren: [body1, body2] })
    const n = node('while_statement', '', { namedChildren: [cond, doGroup] })
    const [c, b] = getWhileParts(n)
    expect(c).toBe(cond)
    expect(b).toEqual([body1, body2])
  })

  it('subshell body is its named children', () => {
    const body1 = node('command', 'x')
    const n = node('subshell', '', { namedChildren: [body1] })
    expect(getSubshellBody(n)).toEqual([body1])
  })
})

describe('getIfBranches', () => {
  it('single if/else returns one branch + else body', () => {
    const cond = node('command', 'cond')
    const thenBody = node('command', 'then')
    const elseBody = node('command', 'else')
    const elseClause = node(NT.ELSE_CLAUSE, '', { namedChildren: [elseBody] })
    const n = node('if_statement', '', { namedChildren: [cond, thenBody, elseClause] })
    const [branches, elseArr] = getIfBranches(n)
    expect(branches).toHaveLength(1)
    expect(branches[0]?.[0]).toBe(cond)
    expect(branches[0]?.[1]).toEqual([thenBody])
    expect(elseArr).toEqual([elseBody])
  })

  it('if/elif/else returns multiple branches', () => {
    const cond1 = node('c1', 'c1')
    const body1 = node('command', 'b1')
    const cond2 = node('c2', 'c2')
    const body2 = node('command', 'b2')
    const elseBody = node('command', 'e')
    const elif = node(NT.ELIF_CLAUSE, '', { namedChildren: [cond2, body2] })
    const elseCl = node(NT.ELSE_CLAUSE, '', { namedChildren: [elseBody] })
    const n = node('if_statement', '', { namedChildren: [cond1, body1, elif, elseCl] })
    const [branches, elseArr] = getIfBranches(n)
    expect(branches).toHaveLength(2)
    expect(branches[0]?.[0]).toBe(cond1)
    expect(branches[1]?.[0]).toBe(cond2)
    expect(elseArr).toEqual([elseBody])
  })
})

describe('getDeclaration* / getUnsetNames / getCommandAssignments', () => {
  it('getDeclarationAssignments collects VARIABLE_ASSIGNMENT children', () => {
    const n = node('declaration_command', '', {
      namedChildren: [
        node(NT.VARIABLE_ASSIGNMENT, 'FOO=bar'),
        node(NT.VARIABLE_ASSIGNMENT, 'BAZ=qux'),
      ],
    })
    expect(getDeclarationAssignments(n)).toEqual(['FOO=bar', 'BAZ=qux'])
  })

  it('getDeclarationKeyword is the first child type', () => {
    const n = node('declaration_command', '', {
      children: [node(NT.EXPORT, 'export', { isNamed: false })],
    })
    expect(getDeclarationKeyword(n)).toBe('export')
  })

  it('getUnsetNames picks VARIABLE_NAME children', () => {
    const n = node('unset_command', '', {
      namedChildren: [node(NT.VARIABLE_NAME, 'FOO'), node(NT.VARIABLE_NAME, 'BAR')],
    })
    expect(getUnsetNames(n)).toEqual(['FOO', 'BAR'])
  })

  it('getCommandAssignments matches VARIABLE_ASSIGNMENT', () => {
    const n = node('command', '', {
      namedChildren: [node(NT.VARIABLE_ASSIGNMENT, 'FOO=1'), node(NT.COMMAND_NAME, 'run')],
    })
    expect(getCommandAssignments(n)).toEqual(['FOO=1'])
  })
})

describe('getTestArgv / getNegatedCommand / getFunction*', () => {
  it('getTestArgv joins text of named children', () => {
    const n = node('test_command', '', {
      namedChildren: [node('word', '-f'), node('word', '/x')],
    })
    expect(getTestArgv(n)).toEqual(['-f', '/x'])
  })

  it('getNegatedCommand returns the inner', () => {
    const inner = node('command', 'foo')
    const n = node('negated_command', '', { namedChildren: [inner] })
    expect(getNegatedCommand(n)).toBe(inner)
  })

  it('getFunctionName returns text of first named child', () => {
    const n = node('function_definition', '', { namedChildren: [node('word', 'myfn')] })
    expect(getFunctionName(n)).toBe('myfn')
  })

  it('getFunctionBody returns compound_statement children', () => {
    const a = node('command', 'a')
    const b = node('command', 'b')
    const compound = node(NT.COMPOUND_STATEMENT, '', { namedChildren: [a, b] })
    const n = node('function_definition', '', {
      namedChildren: [node('word', 'myfn'), compound],
    })
    expect(getFunctionBody(n)).toEqual([a, b])
  })

  it('getFunctionBody returns null when no compound statement', () => {
    const n = node('function_definition', '', { namedChildren: [node('word', 'myfn')] })
    expect(getFunctionBody(n)).toBeNull()
  })
})

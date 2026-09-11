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
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import type { ShellParser } from './parse/index.ts'
import type { TSNodeLike } from './types.ts'
import {
  braceExpands,
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
  getWhileParts,
  literalWord,
  splitEnvPrefix,
} from './helpers.ts'
import { NodeType as NT, type Redirect, RedirectKind } from './types.ts'

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

// Redirect.targetNode is declared `unknown`, so narrow it once here
// instead of casting at every assertion.
function targetTypeOf(redirect: Redirect | undefined): string | undefined {
  return (redirect?.targetNode as TSNodeLike | null | undefined)?.type
}

function redirectStatement(
  targetType: string,
  targetText: string,
  op: string = NT.REDIRECT_OUT,
): TSNodeLike {
  const command = node(NT.COMMAND, 'echo x', {
    namedChildren: [node(NT.COMMAND_NAME, 'echo')],
  })
  const target = node(targetType, targetText)
  const redirect = node(NT.FILE_REDIRECT, `${op} ${targetText}`, {
    children: [node(op, op, { isNamed: false }), target],
    namedChildren: [target],
  })
  return node(NT.REDIRECTED_STATEMENT, `echo x ${op} ${targetText}`, {
    namedChildren: [command, redirect],
  })
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
      children: [node(NT.COMMAND_NAME, 'ls'), node(NT.WORD, '/ram')],
    })
    expect(getParts(n).map((c) => c.text)).toEqual(['ls', '/ram'])
  })

  it('skips FILE_REDIRECT and HERESTRING_REDIRECT children', () => {
    const n = node('command', '', {
      children: [
        node(NT.COMMAND_NAME, 'echo'),
        node(NT.WORD, 'hi'),
        node(NT.FILE_REDIRECT, '>file'),
      ],
    })
    expect(getParts(n)).toHaveLength(2)
  })

  it('keeps a bare $ argument but not the $"..." marker', () => {
    const dollar = node('$', '$', { isNamed: false })
    dollar.startIndex = 5
    dollar.endIndex = 6
    const gapped = node(NT.STRING, '"x"')
    gapped.startIndex = 7
    gapped.endIndex = 10
    const bare = node('command', 'echo $ "x"', {
      children: [node(NT.COMMAND_NAME, 'echo'), dollar, gapped],
    })
    expect(getParts(bare).map((c) => c.text)).toEqual(['echo', '$', '"x"'])

    const marker = node('$', '$', { isNamed: false })
    marker.startIndex = 5
    marker.endIndex = 6
    const adjacent = node(NT.STRING, '"x"')
    adjacent.startIndex = 6
    adjacent.endIndex = 9
    const translated = node('command', 'echo $"x"', {
      children: [node(NT.COMMAND_NAME, 'echo'), marker, adjacent],
    })
    expect(getParts(translated).map((c) => c.text)).toEqual(['echo', '"x"'])
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

describe('getRedirects quoted targets', () => {
  // Quoting a redirect target is purely syntactic in bash. raw_string
  // (single quotes) was missing from the target-type gate, so the
  // target node was dropped and the target fell back to '', silently
  // redirecting every single-quoted target to one phantom empty path.
  it.each([
    [NT.RAW_STRING, "'/out.txt'"],
    [NT.STRING, '"/out.txt"'],
    [NT.WORD, '/out.txt'],
    [NT.ANSI_C_STRING, "$'/out 1.txt'"],
    [NT.TRANSLATED_STRING, '$"/out.txt"'],
  ])('carries the target node for %s', (targetType, targetText) => {
    const [, redirects] = getRedirects(redirectStatement(targetType, targetText))
    expect(redirects[0]?.targetNode).not.toBeNull()
    expect(targetTypeOf(redirects[0])).toBe(targetType)
    expect(redirects[0]?.target).toBe(targetText)
  })

  // Every operator shares parseFileRedirect, so a single-quoted target
  // has to survive on all of them, not just plain `>`.
  it.each([NT.REDIRECT_APPEND, NT.REDIRECT_IN, NT.REDIRECT_BOTH])(
    'carries a raw_string target for %s',
    (op) => {
      const [, redirects] = getRedirects(redirectStatement(NT.RAW_STRING, "'/out.txt'", op))
      expect(targetTypeOf(redirects[0])).toBe(NT.RAW_STRING)
    },
  )

  it('carries a raw_string herestring body', () => {
    const body = node(NT.RAW_STRING, "'hi'")
    const herestring = node(NT.HERESTRING_REDIRECT, "<<< 'hi'", {
      children: [node(NT.HERESTRING_TOKEN, '<<<', { isNamed: false }), body],
      namedChildren: [body],
    })
    const cmd = node(NT.COMMAND, "cat <<< 'hi'", {
      namedChildren: [node(NT.COMMAND_NAME, 'cat'), herestring],
    })
    const outWord = node(NT.WORD, 'out.txt')
    const outRedirect = node(NT.FILE_REDIRECT, '> out.txt', {
      children: [node(NT.REDIRECT_OUT, '>', { isNamed: false }), outWord],
      namedChildren: [outWord],
    })
    const statement = node(NT.REDIRECTED_STATEMENT, "cat <<< 'hi' > out.txt", {
      namedChildren: [cmd, outRedirect],
    })
    const [, redirects] = getRedirects(statement)
    const here = redirects.filter((r) => r.kind === RedirectKind.HERESTRING)
    expect(here).toHaveLength(1)
    expect(targetTypeOf(here[0])).toBe(NT.RAW_STRING)
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

describe('getDeclaration* / getCommandAssignments', () => {
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

describe('literalWord', () => {
  async function literals(line: string, home: string | null = null): Promise<(string | null)[]> {
    const parser = await getTestParser()
    const first = parser.parse(line).children[0] as TSNodeLike
    const [, parts] = splitEnvPrefix(getParts(first))
    return parts.map((p) => literalWord(p, home))
  }

  it.each([
    // Plain, quoted and escaped words read as the text they name.
    ['rm x', ['rm', 'x']],
    ['\'rm\' "/a b" c', ['rm', '/a b', 'c']],
    ['\\rm a"b"c "a\\"b"', ['rm', 'abc', 'a"b']],
    ['$\'x\\ty\' $"hi" 3', ['x\ty', 'hi', '3']],
    ['echo $ /a*', ['echo', '$', '/a*']],
    // A word only the runtime can expand reads as null, wherever it sits
    // and however it is quoted or joined.
    ['$cmd /x', [null, '/x']],
    ['"$cmd" x', [null, 'x']],
    ['${cmd} a$b', [null, null]],
    ['eval "$P"', ['eval', null]],
    ['cat "$d"/x --f="$v"', ['cat', null, null]],
    ['rm $((1+2)) $(date) <(ls)', ['rm', null, null, null]],
    // Brace expansion multiplies words, so it is not literal either; a
    // lone {} and a quoted brace are.
    ["rm /r/{a,b} x{1..3} {} '{a,b}'", ['rm', null, null, '{}', '{a,b}']],
  ])('reads %s before expansion', async (line, expected) => {
    expect(await literals(line)).toEqual(expected)
  })

  it('expands a leading unquoted tilde only', async () => {
    expect(await literals('ls ~ ~/x "~/y" ~u a~ ~/x"y"', '/home/me')).toEqual([
      'ls',
      '/home/me',
      '/home/me/x',
      '~/y',
      '~u',
      'a~',
      '/home/me/xy',
    ])
    // No $HOME: the tilde stays, as in bash.
    expect(await literals('ls ~/x')).toEqual(['ls', '~/x'])
  })

  it('braceExpands', () => {
    expect(braceExpands('{a,b}')).toBe(true)
    expect(braceExpands('x{1..3}y')).toBe(true)
    expect(braceExpands('{a,{b,c}}')).toBe(true)
    expect(braceExpands('{}')).toBe(false)
    expect(braceExpands('{abc}')).toBe(false)
    expect(braceExpands('a,b')).toBe(false)
    expect(braceExpands('{a,b')).toBe(false)
  })
})

describe('claimedDescriptor', () => {
  function statement(parser: ShellParser, line: string): [TSNodeLike, TSNodeLike] {
    const stmt = parser.parse(line).children[0]
    const command = stmt?.namedChildren[0]
    if (stmt === undefined || command === undefined) throw new Error(`no statement in ${line}`)
    return [stmt, command]
  }

  it('reads a bare 0 touching the operator as the descriptor', async () => {
    const parser = await getTestParser()
    const [stmt, command] = statement(parser, 'cat a 0>&-')
    expect(getParts(command).map((c) => c.text)).toEqual(['cat', 'a'])
    expect(getRedirects(stmt)[1].map((r) => [r.fd, r.target])).toEqual([[0, -1]])
    const [spaced, spacedCommand] = statement(parser, 'cat a 0 >&-')
    expect(getParts(spacedCommand).map((c) => c.text)).toEqual(['cat', 'a', '0'])
    expect(getRedirects(spaced)[1].map((r) => r.fd)).toEqual([1])
    const [chained] = statement(parser, 'cat 0<a >b')
    expect(getRedirects(chained)[1].map((r) => [r.fd, r.target])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ])
  })
})

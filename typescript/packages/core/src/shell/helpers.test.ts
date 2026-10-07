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
import { Language, Parser } from 'web-tree-sitter'
import { assert, beforeAll, describe, expect, it } from 'vitest'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import type { ShellParser } from './parse/index.ts'
import type { TSNodeLike } from './types.ts'
import {
  braceExpands,
  byteOffset,
  getCommandName,
  getDeclarationKeyword,
  getCaseItems,
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getFunctionSource,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getPipelineStages,
  getProcessSubBody,
  getRedirects,
  takeContinuation,
  getText,
  getWhileParts,
  isBackgrounded,
  literalWord,
  quotedParts,
  sourceParts,
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
  // The parser's redirect shield reads every `<<<` the way bash does, so a
  // herestring keeps its place among the statement's redirects.
  async function redirectsOf(line: string): Promise<Redirect[]> {
    const parser = await getTestParser()
    return getRedirects(parser.parse(line).children[0] as TSNodeLike)[1]
  }

  it('keeps a herestring before an outer file redirect', async () => {
    expect((await redirectsOf('cat <<< here < input.txt')).map((r) => r.kind)).toEqual([
      RedirectKind.HERESTRING,
      RedirectKind.STDIN,
    ])
  })

  it('keeps a herestring after a file redirect', async () => {
    const redirects = await redirectsOf('cat < input.txt <<< here')
    expect(redirects.map((r) => r.kind)).toEqual([RedirectKind.STDIN, RedirectKind.HERESTRING])
    expect(redirects[1]?.target).toBe('here')
  })

  it('carries a raw_string herestring body', async () => {
    const here = (await redirectsOf("cat <<< 'hi' > out.txt")).filter(
      (r) => r.kind === RedirectKind.HERESTRING,
    )
    expect(here).toHaveLength(1)
    expect(targetTypeOf(here[0])).toBe(NT.RAW_STRING)
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

type StagesShape = [
  string[],
  boolean[],
  string[][],
  boolean,
  [string, string | null, string] | null,
]

describe('getPipelineStages', () => {
  async function shape(line: string, redirected: boolean): Promise<StagesShape> {
    const parser = await getTestParser()
    const first = parser.parse(line).children[0] as TSNodeLike
    const [body, redirects] = redirected ? getRedirects(first) : [first, []]
    if (body === null) throw new Error('no body')
    const stages = getPipelineStages(body, redirects)
    const lead = stages.lead
    return [
      stages.commands.map((c) => getText(c)),
      [...stages.stderrFlags],
      stages.redirects.map((rs) => rs.map((r) => String(r.target))),
      stages.negated,
      lead === null ? null : [getText(lead[0]), lead[1], getText(lead[2])],
    ]
  }

  it.each<[string, boolean, StagesShape]>([
    ['a | b', false, [['a', 'b'], [false], [[], []], false, null]],
    ['! a | b', false, [['a', 'b'], [false], [[], []], true, null]],
    // tree-sitter reads these as pipeline(redirected(<chain>, r), ...).
    ['a | b < f | c', false, [['a', 'b', 'c'], [false, false], [[], ['f'], []], false, null]],
    ['a | b < f |& c', false, [['a', 'b', 'c'], [false, true], [[], ['f'], []], false, null]],
    ['! a < f | b', false, [['a', 'b'], [false], [['f'], []], true, null]],
    ['a && b < f | c', false, [['b', 'c'], [false], [['f'], []], false, ['a', '&&', 'b']]],
    [
      'a && b | c < f | d',
      false,
      [['b', 'c', 'd'], [false, false], [[], ['f'], []], false, ['a', '&&', 'b | c']],
    ],
    ['a || ! b < f | c', false, [['b', 'c'], [false], [['f'], []], true, ['a', '||', '! b']]],
    [
      'a && b | c < f | d > g | e',
      false,
      [
        ['b', 'c', 'd', 'e'],
        [false, false, false],
        [[], ['f'], ['g'], []],
        false,
        ['a', '&&', 'b | c'],
      ],
    ],
    // A stage holding its own redirect runs as the node it is.
    ['a < f | b', false, [['a < f', 'b'], [false], [[], []], false, null]],
    ['{ a; } < f | b', false, [['{ a; } < f', 'b'], [false], [[], []], false, null]],
    // Redirects hoisted over the whole pipeline bind to its last stage.
    ['a | b > g', true, [['a', 'b'], [false], [[], ['g']], false, null]],
    ['! a | b < f > g', true, [['a', 'b'], [false], [[], ['f', 'g']], true, null]],
  ])('%s', async (line, redirected, expected) => {
    expect(await shape(line, redirected)).toEqual(expected)
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

describe('getWhileParts', () => {
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
  it('getDeclarationKeyword is the first child type', () => {
    const n = node('declaration_command', '', {
      children: [node(NT.EXPORT, 'export', { isNamed: false })],
    })
    expect(getDeclarationKeyword(n)).toBe('export')
  })
})

describe('getTestArgv / getNegatedCommand / getFunction*', () => {
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

describe('isBackgrounded', () => {
  async function firstOf(line: string): Promise<TSNodeLike> {
    const parser = await getTestParser()
    return parser.parse(line).children[0] as TSNodeLike
  }

  it("reads the statement's own terminator", async () => {
    const [, , body] = getForParts(await firstOf('for i in 1; do a & b; c && d; done'))
    expect(body.map(getText)).toEqual(['a', 'b', 'c && d'])
    expect(body.map(isBackgrounded)).toEqual([true, false, false])
  })

  it.each<[string, (n: TSNodeLike) => TSNodeLike[]]>([
    ['if true; then a & fi', (n) => getIfBranches(n)[0][0]?.[1] ?? []],
    ['if false; then :; elif true; then a & fi', (n) => getIfBranches(n)[0][1]?.[1] ?? []],
    ['if false; then :; else a & fi', (n) => getIfBranches(n)[1] ?? []],
    ['while false; do a & done', (n) => getWhileParts(n)[1]],
    ['until true; do a & done', (n) => getWhileParts(n)[1]],
    ['for ((;;)); do a & done', (n) => getCforParts(n)[1]],
    ['case x in x) a & ;; esac', (n) => getCaseItems(n)[0]?.[1] ?? []],
    ['f() { a & }', (n) => getFunctionBody(n) ?? []],
    ['{ a & }', (n) => [...n.namedChildren]],
  ])('sees the ampersand in %s', async (line, extract) => {
    const body = extract(await firstOf(line))
    expect(body.map(getText)).toEqual(['a'])
    expect(body.map(isBackgrounded)).toEqual([true])
  })
})

describe('a descriptor touching its operator', () => {
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

// ── heredoc operator-line tail ───────────────────────────────────────────

describe('heredocTail', () => {
  let rawParser: Parser
  beforeAll(async () => {
    // These helpers consume native tree-sitter heredoc nodes. The workspace
    // parser lowers heredocs before parsing and covers execution in integration.
    const require = createRequire(import.meta.url)
    await Parser.init({
      wasmBinary: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    })
    const language = await Language.load(
      new Uint8Array(readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))),
    )
    rawParser = new Parser()
    rawParser.setLanguage(language)
  })
  const heredoc = (line: string): TSNodeLike => {
    const stmt = rawParser.parse(line)?.rootNode.children[0]
    if (stmt?.type !== NT.REDIRECTED_STATEMENT) throw new Error(line)
    return stmt
  }
  const first = (redirects: Redirect[]): Redirect => {
    const only = redirects[0]
    if (only === undefined) throw new Error('no redirect')
    return only
  }
  const steps = (redirect: Redirect): [string, string][] =>
    (redirect.continuation as readonly (readonly [string, TSNodeLike])[]).map(([op, right]) => [
      op,
      getText(right),
    ])

  it('a list step is a continuation, not a pipe', () => {
    // tree-sitter parses `|| echo recovered` inside the heredoc_redirect;
    // a bare command there used to be taken for a pipeline stage.
    const [, redirects] = getRedirects(heredoc("false <<'EOF' || echo recovered\nignored\nEOF"))
    expect(redirects).toHaveLength(1)
    expect(first(redirects).pipeline).toBeNull()
    expect(steps(first(redirects))).toEqual([['||', 'echo recovered']])
  })

  it('unwinds a list along its left spine', () => {
    // `false <<EOF || echo a && echo b` is `(false || echo a) && echo b`.
    const [, redirects] = getRedirects(heredoc('false <<EOF || echo a && echo b\nx\nEOF'))
    expect(steps(first(redirects))).toEqual([
      ['||', 'echo a'],
      ['&&', 'echo b'],
    ])
  })

  it('a pipe then a list', () => {
    const [, redirects] = getRedirects(heredoc('cat <<EOF | tr a-z A-Z && echo done\nabc\nEOF'))
    const only = first(redirects)
    expect(getText(only.pipeline as TSNodeLike)).toBe('tr a-z A-Z')
    expect(steps(only)).toEqual([['&&', 'echo done']])
  })

  it('a plain pipe keeps the pipeline node', () => {
    const [, redirects] = getRedirects(heredoc('cat <<EOF | tr a-z A-Z\nabc\nEOF'))
    const only = first(redirects)
    expect((only.pipeline as TSNodeLike).type).toBe(NT.PIPELINE)
    expect(only.continuation).toEqual([])
  })

  it('after a hoisted file redirect', () => {
    const [, redirects] = getRedirects(heredoc('cat <<EOF > /o && cat /o\ninner\nEOF'))
    expect(redirects.map((r) => r.kind)).toEqual([RedirectKind.HEREDOC, RedirectKind.STDOUT])
    expect(steps(first(redirects))).toEqual([['&&', 'cat /o']])
  })

  it('takeContinuation detaches the steps', () => {
    const [, redirects] = getRedirects(heredoc('false <<EOF || echo a && echo b\nx\nEOF'))
    expect(takeContinuation(redirects).map(([op]) => op)).toEqual(['||', '&&'])
    expect(first(redirects).continuation).toEqual([])
    expect(takeContinuation(redirects)).toEqual([])
  })
})

describe('byteOffset', () => {
  it('counts the bytes before an index', () => {
    expect(byteOffset('cat é x', 4)).toBe(4)
    expect(byteOffset('cat é x', 5)).toBe(6)
    expect(byteOffset('cat é x', 7)).toBe(8)
    expect(byteOffset('', 0)).toBe(0)
  })

  it('counts a byte sentinel as one byte', () => {
    // grep decodes a line so an invalid byte survives -a; each sentinel
    // stands for exactly one byte, which TextEncoder alone would widen to
    // the three bytes of U+FFFD.
    expect(byteOffset('a\udcffb', 2)).toBe(2)
    expect(byteOffset('a\udcffb', 3)).toBe(3)
  })
})

describe('sourceParts', () => {
  function spelled(parts: Iterable<string | TSNodeLike>): (string | [string, string])[] {
    return [...parts].map((part) => (typeof part === 'string' ? part : [part.type, part.text]))
  }

  function argument(parser: ShellParser, line: string): TSNodeLike {
    const node = parser.parse(line).children[0]?.children[1]
    if (node === undefined) throw new Error('no argument')
    return node
  }

  it.each<[string, (string | [string, string])[]]>([
    [
      'echo "😀界\n $x \t\n "',
      ['', ['string_content', '😀界'], '\n', ['simple_expansion', ' $x'], ' \t\n', ' '],
    ],
    ['echo "a\\\n $x"', ['', ['string_content', 'a '], ['simple_expansion', '$x'], '']],
  ])('keeps the text between the children of %j', async (line, parts) => {
    // web-tree-sitter counts offsets in UTF-16 code units, so a surrogate
    // pair before a gap must not shift the slice. The reader joins a line
    // continuation before the grammar sees it.
    expect(spelled(quotedParts(argument(await getTestParser(), line)))).toEqual(parts)
  })

  it.each<[string, (string | [string, string])[]]>([
    [
      'echo "${u:-\t$f}"',
      [
        ['${', '${'],
        ['variable_name', 'u'],
        [':-', ':-'],
        '\t',
        ['simple_expansion', '$f'],
        ['}', '}'],
      ],
    ],
    [
      'echo "${f/x/\\ $f}"',
      [
        ['${', '${'],
        ['variable_name', 'f'],
        ['/', '/'],
        ['regex', 'x'],
        ['/', '/'],
        '\\ ',
        ['simple_expansion', '$f'],
        ['}', '}'],
      ],
    ],
  ])('yields the text no child of %j owns', async (line, parts) => {
    const expansion = argument(await getTestParser(), line).children[1]
    if (expansion === undefined) throw new Error('no expansion')
    expect(spelled(sourceParts(expansion))).toEqual(parts)
  })
})

it.each([
  ['echo λ🙂; f() { echo x; }; echo unrelated', 'f() { echo x; }'],
  [
    'f() { alias late=echo; late; } >out 2>&1; echo unrelated',
    'f() { alias late=echo; late; } >out 2>&1',
  ],
  [
    "f() { cat <<'EOF'; }; echo unrelated\nλ🙂 $literal\nEOF",
    "f() { cat <<'EOF'; }\nλ🙂 $literal\nEOF",
  ],
  [
    'f() { cat <<A; cat <<B; }; echo unrelated\nfirst\nA\nsecond\nB',
    'f() { cat <<A; cat <<B; }\nfirst\nA\nsecond\nB',
  ],
  ['f() { cat <<EOF\ninside\nEOF\n}; echo unrelated', 'f() { cat <<EOF\ninside\nEOF\n}'],
  ['f() { cat; } <<EOF; echo unrelated\nhi\nEOF', 'f() { cat; } <<EOF\nhi\nEOF'],
  [
    'f() { cat; } <<A >/dev/null <<B; echo u\na\nA\nb\nB',
    'f() { cat; } <<A >/dev/null <<B\na\nA\nb\nB',
  ],
])('copies only the function source: %s', async (line, expected) => {
  const program = (await getTestParser()).parseProgram(line)
  try {
    const node = program.root.namedChildren.find(
      (n) => n.type === 'function_definition' || n.type === 'redirected_statement',
    )
    assert(node)
    expect(getFunctionSource(node)).toBe(expected)
  } finally {
    program.release()
  }
})

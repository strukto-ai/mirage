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
import {
  arithReads,
  assignmentValues,
  commandInvocations,
  commandWords,
  createShellParser,
  identifierNames,
  referencedNames,
  type ShellParser,
} from './index.ts'
import type { TSNodeLike } from '../types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('referencedNames', () => {
  it.each<[string, string[]]>([
    ['echo $X', ['X']],
    ['echo ${X:-d}', ['X']],
    ['echo "$X"', ['X']],
    // Single quotes tokenize as raw_string with no children, so the
    // name inside is never a reference.
    ["echo '$X'", []],
    ['echo $((X+1))', ['X']],
    // The assignment's own name is a write, not a read; the
    // substitution body is walked.
    ['x=$(echo $Y)', ['Y']],
    // An append starts from the value it extends, so its target is a
    // read where a plain assignment's is not.
    ['TOKEN+=x', ['TOKEN']],
    ['export V+=$W', ['V', 'W']],
    ['cat <$F', ['F']],
    // The loop variable is a write; the word list is a read.
    ['for i in $L; do echo hi; done', ['L']],
    // Over-approximation on purpose: the walk is textual over the
    // whole tree, so a name an eval would read is fetched too.
    ['x=$(eval "$Z")', ['Z']],
    ['echo ${a[i]}', ['a']],
    ['(( X=Y+1 ))', ['X', 'Y']],
    ['export V=$W', ['W']],
    // Bare names under a declaring builtin declare or delete.
    ['readonly R', []],
    ['unset X', []],
    ['TOKEN=1 printenv', []],
    ['cat <<EOT\nhello $H\nEOT', ['H']],
    ['echo hi', []],
    // A definition's body runs at invocation, not here; the fill layer
    // joins invoked bodies back in through lineNodes.
    ['f() { echo "$T"; }', []],
    ['f() { echo "$T"; }; echo $U', ['U']],
  ])('%s reads %j', (command, names) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(referencedNames(root)).toEqual(new Set(names))
  })
})

describe('commandWords', () => {
  it.each<[string, string[]]>([
    ['echo hi', ['echo']],
    ['env | grep A', ['env', 'grep']],
    ['x=$(printenv)', ['printenv']],
    ['if env; then ls; fi', ['env', 'ls']],
    // The declaring builtins parse as their own node types; their
    // head word is still a command word.
    ['export X=1', ['export']],
    ['declare -p', ['declare']],
    ['unset X', ['unset']],
    ['set', ['set']],
    ['x=1', []],
    // A definition's body runs at invocation; only the call is a
    // command word here.
    ['f() { python3 x.py; }; f', ['f']],
  ])('%s speaks %j', (command, words) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(commandWords(root)).toEqual(new Set(words))
  })
})

describe('commandInvocations', () => {
  it.each<[string, [string | null, (string | null)[]][]]>([
    ['ntn api get PAGE', [['ntn', ['api', 'get', 'PAGE']]]],
    // A dynamic word arrives as null, distinguishable from absent.
    ['slack msg send --to $u', [['slack', ['msg', 'send', '--to', null]]]],
    // A dynamic head is null too: the program itself is undecidable
    // before expansion.
    ['$tool api get', [[null, ['api', 'get']]]],
    ['"$t"x run', [[null, ['run']]]],
    ['A=1 mycli run', [['mycli', ['run']]]],
    ['mycli \'lit arg\' "plain"', [['mycli', ['lit arg', 'plain']]]],
    ['mycli run > out.txt', [['mycli', ['run']]]],
    ['export X=1', []],
    ['f() { inner verb; }', []],
  ])('%s invokes %j', (command, invocations) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(commandInvocations(root)).toEqual(invocations)
  })
})

describe('identifierNames', () => {
  it.each<[string, string[]]>([
    ['TOKEN + 1', ['TOKEN']],
    ['a*b - c', ['a', 'b', 'c']],
    ['42', []],
    // Over-approximation on purpose: the hex literal sheds a token
    // that names nothing real.
    ['0x1f', ['x1f']],
    ['', []],
  ])('%j tokenizes to %j', (text, names) => {
    expect(identifierNames(text)).toEqual(new Set(names))
  })
})

describe('arithReads', () => {
  it.each<[string, string[]]>([
    // The expansion forms, with variable_name and bare-word spellings.
    ['echo $((name))', ['name']],
    ['echo $((a + b*2))', ['a', 'b']],
    ['echo $[x+1]', ['x']],
    // The ((...)) command and a c-style for's header.
    ['((x = y + 1))', ['x', 'y']],
    ['for ((i=0; i<n; i++)); do echo hi; done', ['i', 'n']],
    // A subscript's index and a substring's offset are arithmetic; the
    // default-value form is not.
    ['echo ${a[i+1]}', ['a', 'i']],
    ['echo ${v:1+off}', ['off']],
    ['echo ${v:-$d}', []],
    // The [[ numeric comparators resolve bare words as variables;
    // string comparison and test/[ never do.
    ['[[ $x -lt lim ]]', ['x', 'lim']],
    ['[[ x == y ]]', []],
    ['test x -lt 5', []],
    // let evaluates each operand as an expression.
    ['let "y = x + 1" z+=2', ['y', 'x', 'z']],
    // A plain expansion is not an arithmetic read.
    ['echo $name', []],
    // A definition's body runs at invocation, not here.
    ['f() { echo $((q)); }', []],
  ])('%s reads %j as arithmetic', (command, names) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(arithReads(root)).toEqual(new Set(names))
  })
})

describe('assignmentValues', () => {
  it.each<[string, [string, string | null, string[]][]]>([
    ['n=TOKEN; echo $((n))', [['n', 'TOKEN', []]]],
    ["n='lit'", [['n', 'lit', []]]],
    // A dynamic value reports its reads instead of a literal.
    ['n=$other', [['n', null, ['other']]]],
    ['n=', [['n', '', []]]],
    // += reports its reads with the target among them: the append
    // starts from the standing value.
    ['n+=$q', [['n', null, ['n', 'q']]]],
    // An element write never replaces the whole value.
    ['a[0]=x', []],
    // A prefix assignment is one too.
    ['N=v printenv', [['N', 'v', []]]],
  ])('%s assigns %j', (command, values) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(assignmentValues(root)).toEqual(
      values.map(([name, literal, reads]) => [name, literal, new Set(reads)]),
    )
  })
})

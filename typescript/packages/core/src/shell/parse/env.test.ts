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
  createShellParser,
  envReads,
  implicitReads,
  opaqueReads,
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

describe('envReads', () => {
  it.each<[string, boolean, string[], string[]]>([
    // env renders on any invocation: bare it prints, with a command it
    // hands the snapshot to a child.
    ['env', true, [], []],
    // An override or removal excludes exactly its name from the whole
    // read: the child cannot observe the standing value.
    ['env FOO=1 mycmd', true, [], ['FOO']],
    ['env -u TOKEN mycmd', true, [], ['TOKEN']],
    ['env --unset=TOKEN mycmd', true, [], ['TOKEN']],
    ['env --unset TOKEN mycmd', true, [], ['TOKEN']],
    ['env -uTOKEN mycmd', true, [], ['TOKEN']],
    ['env -u A B=2 mycmd', true, [], ['A', 'B']],
    // A literal ignore-environment form proves the start is empty, so
    // nothing existing is read.
    ['env -i', false, [], []],
    ['env -i mycmd', false, [], []],
    ['env --ignore-environment mycmd', false, [], []],
    ['env - mycmd', false, [], []],
    ['env -0i', false, [], []],
    ['env -iu X mycmd', false, [], []],
    // -u consumes a value, so `-ui` unsets a variable named i and
    // `-u -i` one named -i; both still read the whole environment.
    ['env -ui mycmd', true, [], ['i']],
    ['env -u -i mycmd', true, [], ['-i']],
    ['env -u X mycmd', true, [], ['X']],
    // The first operand ends the options, and -- ends them too.
    ['env X=1 -i mycmd', true, [], ['X']],
    ['env -- -i mycmd', true, [], []],
    // A word no static read can spell ends the claim: it may be the
    // command, demoting later words to arguments. What was consumed
    // before it keeps its effect; after a proven -i it changes nothing.
    ['env $x mycmd', true, [], []],
    ['env -u A $x -u B mycmd', true, [], ['A']],
    ['env A=1 $x B=2 mycmd', true, [], ['A']],
    ['env -i $x', false, [], []],
    // An option the builtin refuses stops it from running at all, so
    // nothing is read.
    ['env --bogus mycmd', false, [], []],
    ['env --unset', false, [], []],
    // An assignment prefix overrides its name for the invocation's
    // environment, whoever renders it; += proves nothing.
    ['TOKEN=local env', true, [], ['TOKEN']],
    ['TOKEN=local set', true, [], ['TOKEN']],
    ['TOKEN=local printenv', true, [], ['TOKEN']],
    ['TOKEN=local printenv TOKEN', false, [], []],
    ['TOKEN=local printenv TOKEN OTHER', false, ['OTHER'], []],
    ['TOKEN+=x printenv TOKEN', false, ['TOKEN'], []],
    ['TOKEN=local env -u OTHER mycmd', true, [], ['TOKEN', 'OTHER']],
    // Exclusions fold by intersection: a name is skippable only when
    // every whole read skips it.
    ['env -u A mycmd; env -u B mycmd', true, [], []],
    ['env -u A mycmd; env -u A other', true, [], ['A']],
    ['env -u A mycmd; export', true, [], []],
    ['set', true, [], []],
    ['set -u', false, [], []],
    ['set -- a b', false, [], []],
    ['printenv', true, [], []],
    ['printenv -0', true, [], []],
    ['printenv PATH TOKEN', false, ['PATH', 'TOKEN'], []],
    // A print target only the runtime can spell selects everything.
    ['printenv $x', true, [], []],
    ['export', true, [], []],
    ['export -p', true, [], []],
    ['export -p TOKEN', false, ['TOKEN'], []],
    // Mutating forms read nothing: the write must not depend on a
    // source being alive.
    ['export TOKEN=local', false, [], []],
    ['export TOKEN', false, [], []],
    ['declare', true, [], []],
    ['declare -p A B', false, ['A', 'B'], []],
    ['declare -x OTHER=1', false, [], []],
    // readonly and local print sets a managed entry can never be in.
    ['readonly', false, [], []],
    ['echo hi', false, [], []],
    // Inside a substitution counts; inside a definition does not.
    ['x=$(env)', true, [], []],
    ['f() { env; }', false, [], []],
  ])('%s renders whole=%s names=%j excluded=%j', (command, whole, names, excluded) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    const reads = envReads(root)
    expect(reads.whole).toBe(whole)
    expect(reads.names).toEqual(new Set(names))
    expect(reads.excluded).toEqual(new Set(excluded))
  })
})

describe('opaqueReads', () => {
  it.each<[string, boolean]>([
    ['echo ${!name}', true],
    ['echo ${!prefix@}', true],
    ['echo ${#name}', false],
    ['echo ${name:-d}', false],
    ['declare -n r=TOKEN', true],
    ['local -n r=TOKEN', true],
    ['typeset -n r=TOKEN', true],
    // -n means unexport / unset-the-ref there, not a nameref.
    ['export -n X', false],
    ['unset -n r', false],
    ['echo $T', false],
    // A definition's body is not read at definition time.
    ['f() { echo ${!name}; }', false],
  ])('%s opaque=%s', (command, opaque) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(opaqueReads(root)).toBe(opaque)
  })
})

describe('implicitReads', () => {
  it.each<[string, string[]]>([
    // A leading tilde reads $HOME wherever a word expands; ~user, a
    // mid-word tilde and a quoted one stay literal.
    ['echo ~', ['HOME']],
    ['echo ~/logs', ['HOME']],
    ['cat < ~/f', ['HOME']],
    ['echo "~" b~ ~user', []],
    // cd reads $HOME bare, $OLDPWD for -, $CDPATH for a searchable
    // relative operand, and everything for a dynamic word.
    ['cd', ['HOME']],
    ['cd --', ['HOME']],
    ['cd -', ['OLDPWD']],
    ['cd -L sub', ['CDPATH']],
    ['cd /a; cd ./b; cd ..', []],
    ['cd ~', ['HOME']],
    ['cd $d', ['HOME', 'OLDPWD', 'CDPATH']],
    // read splits on $IFS; getopts resumes from $OPTIND and consults
    // $OPTERR before printing a diagnostic.
    ['read v', ['IFS']],
    ['getopts ab o', ['OPTIND', 'OPTERR']],
    // A definition's body runs at invocation, not here.
    ['f() { cd; }', []],
  ])('%s reads %j', (command, names) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(implicitReads(root)).toEqual(new Set(names))
  })
})

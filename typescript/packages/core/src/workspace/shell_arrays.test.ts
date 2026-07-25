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
import { makeIntegrationWS, run, runResult } from './fixtures/integration_fixture.ts'

const CASES: [string, string][] = [
  ['a=(one two three); echo "${a[0]}"', 'one\n'],
  ['a=(one two three); echo "${a[1]}"', 'two\n'],
  ['a=(one two three); echo "${a[2]}"', 'three\n'],
  ['a=(one two three); echo "${a[@]}"', 'one two three\n'],
  ['a=(one two three); echo "${a[*]}"', 'one two three\n'],
  ['a=(one two three); echo "${#a[@]}"', '3\n'],
  ['a=(); echo "${#a[@]}"', '0\n'],
  ['a=(x y z); for i in "${a[@]}"; do echo $i; done', 'x\ny\nz\n'],
  ['declare -a arr=(a b c); echo "${arr[@]}"', 'a b c\n'],
  ['a=("hello world" foo); echo "${a[0]}"', 'hello world\n'],
  ['a=(one two three); echo "${a[-1]}"', 'three\n'],
  ['a=(one two three); echo "$a"', 'one\n'],
  ['a=(1 2 3 4); echo ${a[@]:1:2}', '2 3\n'],
  ['a=(1 2 3 4); echo ${a[@]:2}', '3 4\n'],
  ['a=(x y z); echo "${!a[@]}"', '0 1 2\n'],
  ['i=1; a=(x y z); echo "${a[i]}"', 'y\n'],
  ['i=1; a=(x y z); echo "${a[i+1]}"', 'z\n'],
  ['a=(cat car cow); echo ${a[@]/c/K}', 'Kat Kar Kow\n'],
  ['a=(a.txt b.txt); echo ${a[@]%.txt}', 'a b\n'],
  ['a=(one two); echo "${a[1]^^}"', 'TWO\n'],
  ['a=(hello hi); echo "${#a[0]}"', '5\n'],
  ['a=(1 2); a+=(3); echo "${#a[@]}"', '3\n'],
  ['s=one; s+=(two); echo "${#s[@]} ${s[0]} ${s[1]}"', '2 one two\n'],
  ['a=(1 2); a[0]=9; echo "${a[@]}"', '9 2\n'],
  ['a=(1 2 3); a[-1]=X; echo "${a[@]}"', '1 2 X\n'],
  ['a=($(echo one two)); echo "${#a[@]}"', '2\n'],
  ['v=ab; v+=cd; echo "$v"', 'abcd\n'],
  ['unset_append_zz+=x; echo "$unset_append_zz"', 'x\n'],
  ['a=(one two); echo "pre${a[@]}post"', 'preone twopost\n'],
  ['a=(w x y z); printf "<%s>" "${a[@]:1:2}"; echo', '<x><y>\n'],
  ['a=(w x y z); set -- "${a[@]:1:2}"; echo "$#"', '2\n'],
  ['a=(w x y z); printf "<%s>" "p${a[@]:1:2}s"; echo', '<px><ys>\n'],
  ['a=(cat car cow); printf "<%s>" "${a[@]/c/K}"; echo', '<Kat><Kar><Kow>\n'],
  ['a=(w x y z); printf "<%s>" "${!a[@]}"; echo', '<0><1><2><3>\n'],
  // Sparse arrays: `unset a[i]` leaves a hole and `a[9]=v` skips one, so
  // the later indices hold still while ${a[@]}/${#a[@]}/${!a[@]} see only
  // the assigned elements. Pinned against GNU bash 5.2.
  [
    'a=(zero one two); unset "a[1]"; echo "${#a[@]} [${a[@]}] [${!a[@]}] [${a[*]}]"',
    '2 [zero two] [0 2] [zero two]\n',
  ],
  ['a=(zero one two); unset "a[1]"; echo "[${a[0]}][${a[1]}][${a[2]}]"', '[zero][][two]\n'],
  ['a=(); a[9]=v; echo "${#a[@]} [${a[@]}] [${!a[@]}] [${a[-1]}]"', '1 [v] [9] [v]\n'],
  ['a=(x y z); unset "a[1]"; echo "[${a[-1]}] [${a[-2]}] [${a[-3]}]"', '[z] [] [x]\n'],
  ['a=(a b c d); unset "a[1]"; echo "[${a[@]:1:2}]"', '[c d]\n'],
  ['a=(a b c d); unset "a[1]"; echo "[${a[@]^^}]"', '[A C D]\n'],
  ['a=(x y z); unset "a[1]"; echo "${a[@]/x/Q}"', 'Q z\n'],
  ['a=(x y z); unset "a[1]"; a+=(w); echo "[${!a[@]}] [${a[@]}]"', '[0 2 3] [x z w]\n'],
  ['a=(x y z); unset "a[2]"; a+=(w); echo "[${!a[@]}] [${a[@]}]"', '[0 1 2] [x y w]\n'],
  ['a=(x y z); unset "a[1]"; echo "${#a[1]} ${#a[2]}"', '0 1\n'],
  ['a=(x y z); unset "a[1]"; for v in "${a[@]}"; do echo "v=[$v]"; done', 'v=[x]\nv=[z]\n'],
  ['a=(x y z); unset "a[0]"; echo "[$a]"', '[]\n'],
  ['a=(x y z); unset "a[1]"; a[1]=NEW; echo "[${!a[@]}] [${a[@]}]"', '[0 1 2] [x NEW z]\n'],
  ['declare -a e; e[3]=x; e[1]=y; echo "${#e[@]} [${!e[@]}] [${e[@]}]"', '2 [1 3] [y x]\n'],
  // A scalar is element 0 of a one-element array, even when empty; an
  // unset name has no elements at all.
  ['Z=""; echo "${#Z[@]} [${Z[@]}] [${!Z[@]}]"', '1 [] [0]\n'],
  ['Y=v; echo "${#Y[@]} [${!Y[@]}]"', '1 [0]\n'],
  ['unset Q; echo "${#Q[@]} [${!Q[@]}]"', '0 []\n'],
  // Slicing an indexed array works on subscripts, not on position among
  // the assigned values, and a negative offset counts from the extent.
  // Pinned against GNU bash 5.2.
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:2}]"', '[d j]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:0}]"', '[b d j]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:2:1}]"', '[d]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:4}]"', '[j]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:0:2}]"', '[b d]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]: -1}]"', '[j]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]: -3}]"', '[j]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]: -20}]"', '[]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[@]:20}]"', '[]\n'],
  ['a=(); a[1]=b; a[3]=d; a[9]=j; echo "[${a[*]:2}]"', '[d j]\n'],
  ['a=(x y z w); unset "a[1]"; echo "[${a[@]:1}]"', '[z w]\n'],
  ['a=(x y z); echo "[${a[@]: -5}]"', '[]\n'],
  ['a=(x y z); echo "[${a[@]: -2}]"', '[y z]\n'],
  // `declare -a` / `local -a` are local to a function and shadow the
  // caller's array with a fresh empty one.
  ['f(){ declare -a leak; leak[2]=x; }; f; echo "[${leak[@]}] ${#leak[@]}"', '[] 0\n'],
  [
    'g=(outer); f(){ declare -a g; g[0]=inner; echo "in=${g[@]}"; }; f; echo "out=${g[@]}"',
    'in=inner\nout=outer\n',
  ],
  ['f(){ local -a l=(a b); echo "in=${l[@]}"; }; f; echo "out=[${l[@]}]"', 'in=a b\nout=[]\n'],
  [
    'm=(keep); f(){ local -a m; m[1]=x; echo "in=${!m[@]}"; }; f; echo "out=${m[@]}"',
    'in=1\nout=keep\n',
  ],
  ['n=(outer); f(){ declare -a n=(inner); }; f; echo "out=${n[@]}"', 'out=outer\n'],
  [
    'x=foo; f(){ declare -a x; echo "in=[${x[@]}] ${#x[@]}"; }; f; echo "out=$x"',
    'in=[] 0\nout=foo\n',
  ],
  // At top level `declare -a` keeps an existing array and migrates an
  // existing scalar to element 0.
  ['x=foo; declare -a x; echo "${#x[@]} [${!x[@]}] [${x[0]}]"', '1 [0] [foo]\n'],
  ['x=""; declare -a x; echo "${#x[@]} [${!x[@]}]"', '1 [0]\n'],
  ['unset x; declare -a x; echo "${#x[@]}"', '0\n'],
  ['a=(1 2 3); declare -a a; echo "[${a[@]}]"', '[1 2 3]\n'],
  ['a=(x); declare -a a+=(y); echo "[${a[@]}]"', '[x y]\n'],
  ['b=(p); declare b+=(q); echo "[${b[@]}]"', '[p q]\n'],
]

describe('shell arrays', () => {
  for (const [cmd, expected] of CASES) {
    it(cmd, async () => {
      const { ws } = await makeIntegrationWS()
      try {
        expect(await run(ws, cmd)).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }

  it('bad negative subscript aborts the line', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, out, err] = await runResult(ws, 'a=(1); a[-5]=x; echo rc=$?')
      expect(code).toBe(1)
      expect(out).toBe('')
      expect(err).toBe('bash: a[-5]: bad array subscript\n')
    } finally {
      await ws.close()
    }
  })

  it('bad subscript is contained by a subshell', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, out] = await runResult(ws, '(a=(1); a[-5]=x); echo rc=$?')
      expect(code).toBe(0)
      expect(out).toBe('rc=1\n')
    } finally {
      await ws.close()
    }
  })

  it('array literal globs resolve to matches', async () => {
    const { ws } = await makeIntegrationWS({ 'g1.txt': 'x\n', 'g2.txt': 'y\n' })
    try {
      expect(await run(ws, 'a=(/data/g*.txt); echo "${#a[@]}"')).toBe('2\n')
    } finally {
      await ws.close()
    }
  })
})

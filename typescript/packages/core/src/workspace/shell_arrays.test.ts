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

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
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native jq (%s backend)', (kind) => {
  it('jq -r .name matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('{"name": "hello"}\n')
      const m = await env.mirage('jq -r .name', data)
      const n = await env.native('jq -r .name', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('jq -c . matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('{"a": 1, "b": 2}\n')
      const m = await env.mirage('jq -c .', data)
      const n = await env.native('jq -c .', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('jq -s . matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('1\n2\n3\n')
      const m = await env.mirage('jq -s .', data)
      const n = await env.native('jq -s .', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    ['jq -R .', 'alpha\nbeta\ngamma\n'],
    ['jq -Rs .', 'alpha\nbeta\ngamma\n'],
    ['jq -Rsc \'split("\\n")\'', 'alpha\nbeta\ngamma\n'],
    ['jq -Rn -c "[inputs]"', 'alpha\nbeta\ngamma\n'],
    ['jq -R .', 'x\ny'],
    ['jq -R .', ''],
    ['jq .', ''],
    ['jq -s .', ''],
    ['jq -sR .', ''],
    ['jq -j .a', '{"a":"x"}'],
    ['jq --raw-output0 .a', '{"a":"x"}'],
    ['jq -S .', '{"b":1,"a":{"d":2,"c":3}}'],
    ['jq -S -c .', '{"b":1,"a":{"d":2,"c":3}}'],
    ['jq -a .', '{"k":"caf\u00e9"}'],
    ['jq -a -r .k', '{"k":"caf\u00e9"}'],
    ['jq --tab .', '{"a":[1,2]}'],
    ['jq --indent 4 .', '{"a":[1,2]}'],
    ['jq --indent 0 .', '{"a":[1,2]}'],
    ['jq --indent -1 .', '{"a":[1,2]}'],
    ['jq --raw-output .a', '{"a":"x"}'],
    ['jq --compact-output .', '{"a":[1,2]}'],
    ['jq --slurp -c .', '{"a":1}\n{"a":2}\n'],
    ['jq -M -c .', '{"a":1}'],
    ['jq --unbuffered -c .', '{"a":1}'],
    ['jq -n -c "1+2"', ''],
    ['jq -n --arg v hello -c "{msg: $v}"', ''],
    ['jq -n --argjson v "[1,2]" -c "{msg: $v}"', ''],
    ['jq -n --arg v 1 --argjson w 2 -c "[$v,$w]"', ''],
    ['jq --arg v hi -c "[.a,$v]"', '{"a":1}'],
    ['jq -c "[., inputs]"', '{"a":1}\n{"a":2}\n{"a":3}\n'],
    ['jq -n -c "[inputs]"', '{"a":1}\n{"a":2}\n'],
    ['jq -c .inputs', '{"inputs":1}\n{"inputs":2}\n'],
    ['jq -c "{inputs}"', '{"inputs":1}\n{"inputs":2}\n'],
    ['jq -c "{inputs: .a}"', '{"a":1}\n{"a":2}\n'],
    ['jq -c \'"no inputs"\'', '{"a":1}\n{"a":2}\n'],
    ['jq -c ". # inputs"', '{"a":1}\n{"a":2}\n'],
    ['jq -c "{a: inputs}"', '1\n2\n'],
    ['jq -c "[1, inputs, 2]"', '9\n8\n'],
    ['jq -c \'"\\(inputs)"\'', '1\n2\n'],
  ])('%s matches native', async (cmd, input) => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode(input)
      expect(await env.mirage(cmd, data)).toBe(await env.native(cmd, data))
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    ['jq -n -c --args "$ARGS" a b', ''],
    ['jq -n -c --args "$ARGS.positional" a b', ''],
    ['jq -n -c --jsonargs "$ARGS.positional" 1 \'{"k":2}\'', ''],
    ['jq -n -c --arg v 1 --args "$ARGS" a', ''],
    ['jq -n -c "$ARGS"', ''],
    ['jq -c "$ARGS.named"', '{"a":1}\n'],
    ['jq -c --stream .', '{"a":1,"b":[1,2]}'],
    ['jq -c --stream .', '{"a":1}\n{"a":2}\n'],
    // A trailing newline matters here: jq's incremental parser splits the
    // closing event into its own slurp group without one, which mirage
    // (which reads whole values) does not reproduce.
    ['jq -c --stream -s .', '{"a":1}\n'],
    ['jq -c --stream ".[0]"', '{"a":1}\n'],
    ['jq --seq -c .', '\u001e{"a":1}\n\u001e{"a":2}\n'],
    ['jq --seq -c -n "1,2"', ''],
  ])('%s matches native (stdin)', async (cmd, input) => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode(input)
      expect(await env.mirage(cmd, data)).toBe(await env.native(cmd, data))
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    ['jq -n -c --rawfile x lines.txt "$x"'],
    ['jq -n -c --slurpfile x multi.json "$x"'],
    ['jq -n -c --rawfile a lines.txt --rawfile b multi.json "[$a,$b]"'],
    ['jq -c --slurpfile s multi.json "[.a, ($s|length)]" one.json'],
  ])('%s matches native (files)', async (cmd) => {
    const env = makeEnv(kind)
    try {
      env.createFile('lines.txt', ENC.encode('alpha\nbeta\n'))
      env.createFile('multi.json', ENC.encode('{"a":1}\n{"a":2}\n'))
      env.createFile('one.json', ENC.encode('{"a":7}\n'))
      expect(await env.mirage(cmd)).toBe(await env.native(cmd))
    } finally {
      await env.cleanup()
    }
  })
})

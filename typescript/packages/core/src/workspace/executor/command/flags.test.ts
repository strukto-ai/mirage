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

import { SPECS, specOf } from '../../../commands/spec/index.ts'
import { PathSpec } from '../../../types.ts'
import { CommandSpec, Option } from '../../../commands/spec/types.ts'
import { optionError, parseFlags } from './flags.ts'

function path(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: '', resolved: true })
}

describe('parseFlags', () => {
  it('separates by type when there is no spec', () => {
    const p = path('/data/a.txt')
    const [paths, texts, flags] = parseFlags([p, 'hello'], null, 'unknown', '/')
    expect(paths).toEqual([p])
    expect(texts).toEqual(['hello'])
    expect(flags).toEqual({})
  })

  it('keeps the classified PathSpec over synthesis', () => {
    const p = path('/data/a.txt')
    const [paths] = parseFlags([p], SPECS.cat ?? null, 'cat', '/')
    expect(paths[0]).toBe(p)
  })

  it('synthesized paths leave the backend key to the mount', () => {
    // A spec-classified PATH operand the classifier left as text; the
    // mount stamps resourcePath at execute time (sentinel-proven in
    // both languages).
    const [paths] = parseFlags(['b.txt'], SPECS.cat ?? null, 'cat', '/data')
    expect(paths.length).toBe(1)
    expect(paths[0]?.resourcePath).toBe('')
  })
})

describe('optionError scan order', () => {
  it('reports the first scan error like GNU', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--context', type: 'str' }), new Option({ long: '--count' })],
    })
    const dec = new TextDecoder()
    const ambiguousFirst = parseFlags(['--c', '--bogus', 'x'], spec, 'grep', '/')
    const refusal = optionError(
      'grep',
      ...([
        ambiguousFirst[4],
        ambiguousFirst[5],
        ambiguousFirst[6],
        ambiguousFirst[7],
        ambiguousFirst[8],
        ambiguousFirst[9],
        ambiguousFirst[10],
        ambiguousFirst[11],
      ] as const),
    )
    expect(refusal).not.toBeNull()
    expect(dec.decode(refusal?.[0]).startsWith("grep: option '--c' is ambiguous")).toBe(true)
    const invalidFirst = parseFlags(['--bogus', '--c', 'x'], spec, 'grep', '/')
    const flipped = optionError(
      'grep',
      ...([
        invalidFirst[4],
        invalidFirst[5],
        invalidFirst[6],
        invalidFirst[7],
        invalidFirst[8],
        invalidFirst[9],
        invalidFirst[10],
        invalidFirst[11],
      ] as const),
    )
    expect(flipped).not.toBeNull()
    expect(dec.decode(flipped?.[0]).startsWith("grep: unrecognized option '--bogus'")).toBe(true)
  })

  it('reports the numeric conversion before the choice list', () => {
    // Numeric-typed values before choices, argparse's order, matching
    // the walk's finishNode: a non-numeric value on a float option that
    // also declares choices refuses the conversion, not the list.
    const spec = new CommandSpec({
      options: [new Option({ long: '--ratio', type: 'float', choices: ['0.5', '1.0'] })],
    })
    const parsed = parseFlags(['--ratio', '5x', 'p'], spec, 'cmd', '/')
    const refusal = optionError(
      'cmd',
      ...([
        parsed[4],
        parsed[5],
        parsed[6],
        parsed[7],
        parsed[8],
        parsed[9],
        parsed[10],
        parsed[11],
      ] as const),
    )
    expect(refusal).not.toBeNull()
    expect(new TextDecoder().decode(refusal?.[0])).toContain("invalid float value: '5x'")
  })
})

describe("optionError — tar's old option style", () => {
  it('reports a missing cluster argument ahead of an undeclared letter', () => {
    // GNU tar counts the cluster's argument needs before argp validates a
    // letter, so `tar Qf` and `tar fQ` both name f.
    for (const argv of [['Qf'], ['fQ']]) {
      const parsed = parseFlags(argv, specOf('tar'), 'tar', '/')
      const refusal = optionError(
        'tar',
        ...([
          parsed[4],
          parsed[5],
          parsed[6],
          parsed[7],
          parsed[8],
          parsed[9],
          parsed[10],
          parsed[11],
          parsed[12],
        ] as const),
      )
      expect(refusal).not.toBeNull()
      expect(new TextDecoder().decode(refusal?.[0])).toBe(
        "tar: Old option 'f' requires an argument.\n" + "Try 'tar --help' for more information.\n",
      )
      expect(refusal?.[1]).toBe(2)
    }
  })

  it('is no refusal when the cluster has its argument', () => {
    const parsed = parseFlags(['xzf', '/data/a.tgz'], specOf('tar'), 'tar', '/')
    const refusal = optionError(
      'tar',
      ...([
        parsed[4],
        parsed[5],
        parsed[6],
        parsed[7],
        parsed[8],
        parsed[9],
        parsed[10],
        parsed[11],
        parsed[12],
      ] as const),
    )
    expect(refusal).toBeNull()
    expect(parsed[2].x).toBe(true)
    expect(parsed[2].z).toBe(true)
  })
})

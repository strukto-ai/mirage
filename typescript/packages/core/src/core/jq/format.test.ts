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
import { jqRunTexts } from './eval.ts'
import {
  dumpText,
  errorReport,
  formatJqOutput,
  haltReport,
  loadFailure,
  printable,
} from './format.ts'
import { jqOptions, type JqOptions } from './types.ts'
import { eacces, eisdir, enoent } from '../../errors/fs.ts'

const DEC = new TextDecoder()
const PRETTY = jqOptions()
const COMPACT = jqOptions({ compact: true })
const RAW = jqOptions({ rawOutput: true, compact: true })

// jq's compact dump of one document, and what jq 1.8.2 (debian:testing-slim)
// prints for it under each set of flags.
const DOC = '{"b":1.000,"1":[1E+2,-0,{},[]],"a":[],"é":"ü😀\\u007f"}'
const LAYOUTS: [string, JqOptions, string][] = [
  [
    'the default',
    jqOptions(),
    '{\n  "b": 1.000,\n  "1": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  "a": [],\n' +
      '  "é": "ü😀\\u007f"\n}\n',
  ],
  ['-c', jqOptions({ compact: true }), `${DOC}\n`],
  [
    '-S',
    jqOptions({ sortKeys: true }),
    '{\n  "1": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  "a": [],\n  "b": 1.000,\n' +
      '  "é": "ü😀\\u007f"\n}\n',
  ],
  [
    '-S -c',
    jqOptions({ sortKeys: true, compact: true }),
    '{"1":[1E+2,-0,{},[]],"a":[],"b":1.000,"é":"ü😀\\u007f"}\n',
  ],
  [
    '--tab',
    jqOptions({ tab: true }),
    '{\n\t"b": 1.000,\n\t"1": [\n\t\t1E+2,\n\t\t-0,\n\t\t{},\n\t\t[]\n\t],\n\t"a": [],\n' +
      '\t"é": "ü😀\\u007f"\n}\n',
  ],
  [
    '--indent 0',
    jqOptions({ indent: 0 }),
    '{\n"b": 1.000,\n"1": [\n1E+2,\n-0,\n{},\n[]\n],\n"a": [],\n"é": "ü😀\\u007f"\n}\n',
  ],
  [
    '--indent 7',
    jqOptions({ indent: 7 }),
    '{\n       "b": 1.000,\n       "1": [\n              1E+2,\n              -0,\n' +
      '              {},\n              []\n       ],\n       "a": [],\n' +
      '       "é": "ü😀\\u007f"\n}\n',
  ],
  [
    '-a',
    jqOptions({ asciiOutput: true }),
    '{\n  "b": 1.000,\n  "1": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  "a": [],\n' +
      '  "\\u00e9": "\\u00fc\\ud83d\\ude00\\u007f"\n}\n',
  ],
  [
    '-a -S --tab',
    jqOptions({ asciiOutput: true, sortKeys: true, tab: true }),
    '{\n\t"1": [\n\t\t1E+2,\n\t\t-0,\n\t\t{},\n\t\t[]\n\t],\n\t"a": [],\n\t"b": 1.000,\n' +
      '\t"\\u00e9": "\\u00fc\\ud83d\\ude00\\u007f"\n}\n',
  ],
  [
    '-r',
    jqOptions({ rawOutput: true }),
    '{\n  "b": 1.000,\n  "1": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  "a": [],\n' +
      '  "é": "ü😀\\u007f"\n}\n',
  ],
]

// A string, and what jq 1.8.2 prints for it.
const STRING = '"ü😀\\u007f\\u0000"'
const STRING_LAYOUTS: [string, JqOptions, string][] = [
  ['-r', jqOptions({ rawOutput: true }), 'ü😀\x7f\x00\n'],
  [
    '-r -a',
    jqOptions({ rawOutput: true, asciiOutput: true }),
    `"\\u00fc\\ud83d\\ude00\\u007f\\u0000"\n`,
  ],
  ['-j', jqOptions({ rawOutput: true, joinOutput: true }), 'ü😀\x7f\x00'],
  ['-a', jqOptions({ asciiOutput: true }), `"\\u00fc\\ud83d\\ude00\\u007f\\u0000"\n`],
]

describe('formatJqOutput', () => {
  it.each(LAYOUTS)('lays an output out the way jq prints it under %s', (_, opts, expected) => {
    expect(DEC.decode(formatJqOutput([DOC], opts))).toBe(expected)
  })

  it.each(STRING_LAYOUTS)('prints a string the way jq prints it under %s', (_, opts, expected) => {
    expect(DEC.decode(formatJqOutput([STRING], opts))).toBe(expected)
  })

  it('returns empty bytes when there are no outputs', () => {
    expect(formatJqOutput([], PRETTY)).toEqual(new Uint8Array(0))
    expect(formatJqOutput([], RAW)).toEqual(new Uint8Array(0))
  })

  it('leaves non-strings as JSON when raw=true', () => {
    expect(DEC.decode(formatJqOutput(['"a"', '1.000'], RAW))).toBe('a\n1.000\n')
  })

  it('lays out a value nested as deep as jq reads', () => {
    const deep = '['.repeat(300) + '1.000' + ']'.repeat(300)
    const pretty = dumpText(deep, PRETTY)
    expect(pretty.startsWith('[\n  [\n    [')).toBe(true)
    expect(pretty.includes(`\n${' '.repeat(600)}1.000\n`)).toBe(true)
    const nested = '{"b":'.repeat(300) + '{"a":1}' + '}'.repeat(300)
    expect(
      dumpText(nested, jqOptions({ compact: true, sortKeys: true })).split('"b"'),
    ).toHaveLength(301)
  })

  it.each([true, false])('sorts keys by code point, escaped ones read (compact: %s)', (compact) => {
    // jq compares keys as UTF-8 bytes, which is code point order.
    const text = '{"é":1,"z":2,"a\\"":3,"😀":4,"ｚ":5,"\\u0001":6}'
    const ordered = '{"\\u0001":6,"a\\"":3,"z":2,"é":1,"ｚ":5,"😀":4}'
    expect(dumpText(text, jqOptions({ compact, sortKeys: true }))).toBe(
      dumpText(ordered, jqOptions({ compact })),
    )
  })

  it('keeps the spelling jq gives each output', async () => {
    const run = await jqRunTexts(
      '{"b":1.000,"1":2}',
      '., .b, (.b + 0), (1e17 * 1), -0, keys_unsorted',
    )
    expect(DEC.decode(formatJqOutput(run.outputs, COMPACT))).toBe(
      '{"b":1.000,"1":2}\n1.000\n1\n1e+17\n0\n["b","1"]\n',
    )
  })
})

describe('jq output flags', () => {
  it('writes no separator under -j', () => {
    const opts = jqOptions({ rawOutput: true, joinOutput: true, compact: true })
    expect(DEC.decode(formatJqOutput(['"a"', '"b"'], opts))).toBe('ab')
  })

  it('terminates with NUL under --raw-output0, which beats -j', () => {
    const opts = jqOptions({ rawOutput: true, joinOutput: true, nulOutput: true, compact: true })
    expect(formatJqOutput(['"a"', '"b"'], opts)).toEqual(new Uint8Array([97, 0, 98, 0]))
  })

  it('puts RS before each value under --seq, but not before a raw string', () => {
    const opts = jqOptions({ seq: true, rawOutput: true, compact: true })
    expect(DEC.decode(formatJqOutput(['1.000', '"x"', '[]'], opts))).toBe('\x1e1.000\nx\n\x1e[]\n')
  })
})

describe('printable', () => {
  it('refuses a string holding a NUL under --raw-output0', () => {
    // Pinned: printf '"a\u0000b" "c"' | jq --raw-output0 . fails the first
    // run with this error and prints the second.
    const opts = jqOptions({ rawOutput: true, nulOutput: true, compact: true })
    const run = { outputs: ['"x"', '"a\\u0000b"', '"c"'], stop: null }
    expect(printable(run, opts)).toEqual({
      outputs: ['"x"'],
      stop: {
        kind: 'error',
        text: 'Cannot dump a string containing NUL with --raw-output0 option',
        string: true,
      },
    })
    const escaped = { outputs: ['"a\\\\u0000"'], stop: null }
    expect(printable(escaped, opts)).toBe(escaped)
    expect(printable(run, jqOptions({ rawOutput: true, compact: true }))).toBe(run)
    expect(printable(run, jqOptions({ nulOutput: true, asciiOutput: true }))).toBe(run)
  })
})

describe('errorReport', () => {
  it('words an error the way jq does', () => {
    expect(errorReport('<stdin>:1', { kind: 'error', text: 'boom', string: true })).toBe(
      'jq: error (at <stdin>:1): boom\n',
    )
    expect(errorReport('<unknown>', { kind: 'error', text: '{"a":1}', string: false })).toBe(
      'jq: error (at <unknown>) (not a string): {"a":1}\n',
    )
  })

  it('ends a string message at a NUL', () => {
    expect(errorReport('f:0', { kind: 'error', text: 'a\0b', string: true })).toBe(
      'jq: error (at f:0): a\n',
    )
  })
})

describe('haltReport', () => {
  it.each([
    ['bye\n', true, 'bye\n'],
    ['{"a":1}', false, '{"a":1}\n'],
    [null, false, ''],
  ])('writes %j (a string: %s) as %j', (message, string, expected) => {
    expect(haltReport({ kind: 'halt', message, string, code: 5 })).toBe(expected)
  })
})

describe('loadFailure', () => {
  it.each([
    [enoent('f'), 'Could not open f: No such file or directory'],
    [eacces('f'), 'Could not open f: Permission denied'],
    [eisdir('f'), "Could not open f: It's a directory"],
  ])('words a file jq could not load (%s)', (error, expected) => {
    expect(loadFailure('f', error)).toBe(expected)
  })
})

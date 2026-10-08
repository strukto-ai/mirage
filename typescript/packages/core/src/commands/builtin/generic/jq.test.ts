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
import { jqOptions, type JqOptions } from '../../../core/jq/index.ts'
import { yieldBytes } from '../../../io/stream.ts'
import { materialize, type ByteSource, type IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir, enoent } from '../../../errors/fs.ts'
import { type CommandOpts } from '../../config.ts'
import { helpPage, versionLine } from '../../spec/standard.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'
import {
  exitCode,
  indentWidth,
  inputName,
  jqGeneric,
  optionRefusal,
  parseFlags,
  positionalValue,
  readOptions,
  runStatus,
} from './jq.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/d/four.json': '1\n2\n3\n4\n',
  '/d/bad.json': '{"a":1}\n{"a":2}\n[',
  '/d/mid.json': '1\n[1 2]\n3\n4\n',
  '/d/one.json': '1',
  '/d/two.json': ' 2\n',
  '/d/-': '42\n',
}

async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  if (path.virtual === '/d/dir') throw eisdir(path)
  const text = FILES[path.virtual]
  if (text === undefined) throw enoent(path)
  const bytes = ENC.encode(text)
  for (let at = 0; at < bytes.length; at += 5) yield bytes.subarray(at, at + 5)
}

interface Ran {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Run jq over files and return what it printed and how it exited. */
async function ranOver(
  paths: readonly string[],
  program: string,
  flags: CommandOpts['flags'] = {},
  stream: typeof read = read,
): Promise<Ran> {
  const opts = {
    stdin: null,
    flags: { compact_output: true, ...flags },
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  const specs = paths.map((path) => PathSpec.fromStrPath(path))
  const result = await jqGeneric(specs, [program], opts, stream)
  if (result === null) throw new Error('jq returned no result')
  const [out, io] = result
  return {
    stdout: DEC.decode(await materialize(out)),
    stderr: DEC.decode(await materialize(io.stderr)),
    exitCode: io.exitCode,
  }
}

/** Run jq over one file and return what it printed and how it exited. */
async function ran(path: string, program: string, flags: CommandOpts['flags'] = {}): Promise<Ran> {
  return ranOver([path], program, flags)
}

function view(flags: Record<string, string | boolean | number | string[]>): FlagView {
  return new FlagView(flags, specOf('jq'))
}

const HINT =
  'Use jq --help for help with command-line options,\n' +
  'or see the jq manpage, or online docs at https://jqlang.org'

/** A jq line's flags as the parser leaves them, with the order they were typed in. */
function parsedFlags(...words: string[]): CommandOpts['flags'] {
  return parseToKwargs(parseCommand(specOf('jq'), words, '/', 'jq'))
}

function toSpec(value: string): PathSpec {
  return PathSpec.fromStrPath(value)
}

async function unread(path: PathSpec): Promise<Uint8Array> {
  await Promise.resolve()
  throw new Error(`${path.virtual} should not be read`)
}

/** The options a walk read to, where it cannot have answered --help. */
function asOptions(result: JqOptions | Uint8Array): JqOptions {
  if (result instanceof Uint8Array) throw new Error('the walk answered --help or --version')
  return result
}

/** What a jq line's option walk answers, its flag files read with `reader`. */
async function walkLine(
  words: readonly string[],
  reader: (path: PathSpec) => Promise<Uint8Array>,
): Promise<JqOptions | Uint8Array> {
  const parsed = parseCommand(specOf('jq'), [...words], '/', 'jq')
  const flags = parseToKwargs(parsed)
  const fl = new FlagView(flags, specOf('jq'))
  return readOptions(fl, parsed.texts(), 'from_file' in flags, toSpec, reader)
}

/** The options a jq line reads to, its flag files read with `reader`. */
async function readLine(
  words: readonly string[],
  reader: (path: PathSpec) => Promise<Uint8Array>,
): Promise<JqOptions> {
  return asOptions(await walkLine(words, reader))
}

/** The options a jq line reads to, its flag files read off FILES. */
async function options(...words: string[]): Promise<JqOptions> {
  return readLine(words, (path) => materialize(read(path)))
}

/** The bindings a flag record makes, where no file may be read. */
async function bound(
  flags: Record<string, string | boolean | number | string[]>,
): Promise<ReadonlyMap<string, string>> {
  return asOptions(await readOptions(view(flags), [], false, toSpec, unread)).namedArgs
}

/** How jq lays an output out under these options. */
function layout(opts: JqOptions): string | number {
  if (opts.compact) return 'compact'
  return opts.tab ? 'tab' : opts.indent
}

describe('parseFlags', () => {
  it('reads -j and --raw-output0 as implying -r', () => {
    expect(parseFlags(view({ join_output: true })).rawOutput).toBe(true)
    expect(parseFlags(view({ raw_output0: true })).rawOutput).toBe(true)
  })
})

describe('indentWidth', () => {
  it.each([
    ['', 0, '3', 3],
    ['+', 0, '3', 3],
    ['', 1, '7', 7],
    ['-', 0, '0', 0],
    ['', 0, '0', 0],
    ['-', 0, '1', -1],
    ['', 5000, '7', 7],
    ['+', 5000, '3', 3],
    ['-', 5000, '1', -1],
    ['-', 5000, '0', 0],
    ['', 5000, '0', 0],
  ] as const)("reads %s, %i zeroes and %s as jq's strtol does", (sign, zeros, digit, width) => {
    expect(indentWidth(sign + '0'.repeat(zeros) + digit)).toBe(width)
  })

  it.each([
    'x',
    '2x',
    '',
    ' 3',
    '3 ',
    '3\n',
    '1.5',
    '0x3',
    '08',
    '-2',
    '99999999999999999999',
    ...(
      [
        ['', '9'],
        ['-', '9'],
        ['+', '9'],
        ['', '0'],
      ] as const
    ).map(([sign, digits]) => sign + digits.repeat(5000) + '8'),
  ])("refuses word %# in jq's words", (word) => {
    expect(() => indentWidth(word)).toThrow(`jq: --indent takes a number between -1 and 7\n${HINT}`)
  })
})

describe('readOptions', () => {
  it('reads --indent -1 as tab indentation', async () => {
    const opts = asOptions(await readOptions(view({ indent: '-1' }), [], false, toSpec, unread))
    expect(opts.tab).toBe(true)
    expect(opts.indent).toBe(2)
  })

  it.each([
    [['-c', '--tab'], 'tab'],
    [['--tab', '-c'], 'compact'],
    [['--indent', '3', '-c'], 'compact'],
    [['-c', '--indent', '3'], 3],
    [['--tab', '--indent', '3'], 3],
    [['--indent', '3', '--tab'], 'tab'],
    [['--indent', '-1', '-c'], 'compact'],
    [['-c', '--indent', '-1'], 'tab'],
    [['-cr', '--tab'], 'tab'],
    [['--tab', '-rc'], 'compact'],
    [['--indent', '2', '--indent', '5'], 5],
  ] as const)('lets the last layout option typed win: %j', async (words, expected) => {
    expect(layout(await options(...words, '.'))).toBe(expected)
  })

  it('reads a later --indent word too', async () => {
    await expect(options('--indent', '2', '--indent', 'x', '.')).rejects.toThrow(
      '--indent takes a number',
    )
  })

  it('binds each --arg name to a string', async () => {
    expect(await bound({ arg: ['a', '1', 'b', 'x"y'] })).toEqual(
      new Map([
        ['a', '"1"'],
        ['b', '"x\\"y"'],
      ]),
    )
  })

  it.each([
    [' {"b":1.000,"1":2} ', '{"b":1.000,"1":2}'],
    ['{"a":1}', '{"a":1}'],
    ['nan', 'nan'],
  ])('keeps the --argjson value %j as the text jq reads', async (value, text) => {
    expect(await bound({ argjson: ['v', value] })).toEqual(new Map([['v', text]]))
  })

  it.each(['nope', '1 2'])(
    'refuses the --argjson value %j with the hint jq 1.8 gives',
    async (value) => {
      await expect(bound({ argjson: ['v', value] })).rejects.toThrow(
        `jq: invalid JSON text passed to --argjson\n${HINT}`,
      )
    },
  )

  it('keeps the bindings in the order they were typed in', async () => {
    const opts = await options(
      '-n',
      '--slurpfile',
      's',
      '/d/four.json',
      '--arg',
      'a',
      '1',
      '--rawfile',
      'r',
      '/d/one.json',
      '--argjson',
      'b',
      '2',
      '$ARGS.named',
    )
    expect([...opts.namedArgs]).toEqual([
      ['s', '[1,2,3,4]'],
      ['a', '"1"'],
      ['r', '"1"'],
      ['b', '2'],
    ])
  })

  it.each([
    [['--argjson', 'v', '1', '--argjson', 'v', '2'], '1'],
    [['--arg', 'v', '1', '--argjson', 'v', '2'], '"1"'],
    [['--rawfile', 'v', '/d/one.json', '--arg', 'v', '2'], '"1"'],
    [['--slurpfile', 'v', '/d/two.json', '--rawfile', 'v', '/d/one.json'], '[2]'],
  ] as const)('lets the first binding of a name win: %j', async (words, text) => {
    expect((await options('-n', ...words, '$v')).namedArgs).toEqual(new Map([['v', text]]))
  })

  it.each([
    [['--argjson', 'v', 'nope']],
    [['--rawfile', 'v', '/d/missing.txt']],
    [['--slurpfile', 'v', '/d/bad.json']],
  ] as const)('never reads a binding of a taken name: %j', async (words) => {
    const opts = await readLine(['-n', '--arg', 'v', '1', ...words, '$v'], unread)
    expect(opts.namedArgs).toEqual(new Map([['v', '"1"']]))
  })
})

/** Inputs named the way jq names files, one per text. */
describe('exitCode', () => {
  const printed = (...outputs: string[]): number => runStatus({ outputs, stop: null })
  const failed = runStatus({ outputs: ['1'], stop: { kind: 'error', text: 'x', string: true } })

  const halted = (code: number | null): number =>
    runStatus({ outputs: ['false'], stop: { kind: 'halt', message: null, string: false, code } })

  it.each([
    [[printed('1', 'false')], true, 1],
    [[printed('false', '1')], true, 0],
    [[printed('null')], true, 1],
    [[printed('"false"'), printed('0.0')], true, 0],
    [[], true, 4],
    [[], false, 0],
    [[printed('null')], false, 0],
    [[failed, printed('1')], false, 0],
    [[printed('1'), failed], false, 5],
    [[failed, printed('false')], true, 1],
    [[printed('false'), printed()], true, 1],
    [[printed('1'), printed()], true, 0],
    [[halted(null)], false, 0],
    [[halted(2)], false, 2],
    [[halted(-1)], false, 0],
    [[halted(-1)], true, 1],
    [[halted(1.5)], false, 1],
    [[halted(300)], false, 44],
  ])('reads the statuses %j (-e %s) as %s', (statuses, exitStatus, expected) => {
    expect(exitCode(statuses, jqOptions({ exitStatus }))).toBe(expected)
  })
})

describe('inputName', () => {
  it('names an input as typed, and - as stdin', () => {
    expect(
      inputName(
        new PathSpec({
          virtual: '/d/a.json',
          directory: '/d/',
          vfsPath: 'd/a.json',
          rawPath: 'a.json',
        }),
      ),
    ).toBe('a.json')
    expect(
      inputName(new PathSpec({ virtual: '/d/a.json', directory: '/d/', vfsPath: 'd/a.json' })),
    ).toBe('/d/a.json')
    expect(
      inputName(
        new PathSpec({
          virtual: '/dev/stdin',
          directory: '/dev/',
          vfsPath: 'dev/stdin',
          rawPath: '-',
        }),
      ),
    ).toBe('<stdin>')
  })
})

describe('positionalValue', () => {
  it('reads an operand under --args as a string', () => {
    expect(positionalValue('args', '1')).toBe('"1"')
  })

  it('keeps each operand under --jsonargs as the text jq reads', () => {
    expect(positionalValue('jsonargs', '1.0')).toBe('1.0')
    expect(positionalValue('jsonargs', '{"b":1,"1":2}')).toBe('{"b":1,"1":2}')
  })

  it("refuses invalid JSON under --jsonargs in jq's words", () => {
    expect(() => positionalValue('jsonargs', 'nope')).toThrow(
      `jq: invalid JSON text passed to --jsonargs\n${HINT}`,
    )
  })
})

describe('readOptions over --args and --jsonargs', () => {
  it.each([
    [
      ['--args', 'a', '--jsonargs', '1', '--args', 'b'],
      ['"a"', '1', '"b"'],
    ],
    [
      ['--jsonargs', '1', '--args', 'a'],
      ['1', '"a"'],
    ],
    [['--args', '--jsonargs', '1'], ['1']],
    [
      ['--args', '{', '--jsonargs', '1'],
      ['"{"', '1'],
    ],
    [
      ['/d/a.json', '--args', 'x', '/d/b.json'],
      ['"x"', '"/d/b.json"'],
    ],
    [
      ['--jsonargs', '1', '--arg', 'x', 'y', '2'],
      ['1', '2'],
    ],
    [
      ['--args', '--', '-x', '--jsonargs'],
      ['"-x"', '"--jsonargs"'],
    ],
    [['/d/a.json'], []],
  ] as const)(
    'files each operand by the mode typed last before it: %j',
    async (words, positional) => {
      expect((await options('-n', '.', ...words)).positionalArgs).toEqual(positional)
    },
  )

  it('takes the program first whatever the mode', async () => {
    const opts = await options('-n', '--jsonargs', '.', '1', '--args', '2', '--jsonargs', '3')
    expect(opts.positionalArgs).toEqual(['1', '"2"', '3'])
  })

  it('leaves every operand to the modes when -f gave the program', async () => {
    const opts = await options(
      '-n',
      '-f',
      '/d/prog.jq',
      '/d/a.json',
      '--args',
      'b',
      '--jsonargs',
      '2',
    )
    expect(opts.positionalArgs).toEqual(['"b"', '2'])
  })

  it.each([
    [{ args: true }, false, ['.', 'a', '1'], ['"a"', '"1"']],
    [{ args: true }, true, ['a', 'b'], ['"a"', '"b"']],
    [{ args: true, jsonargs: true }, false, ['.', '1'], ['1']],
    [{ jsonargs: true, args: true }, false, ['.', '1'], ['"1"']],
    [{}, false, ['.', 'a'], []],
  ] as const)(
    'files the operands of a record with no tape after every option: %j',
    async (flags, hasProgramFile, texts, positional) => {
      const opts = asOptions(await readOptions(view(flags), texts, hasProgramFile, toSpec, unread))
      expect(opts.positionalArgs).toEqual(positional)
    },
  )
})

describe('jq flag-file readers', () => {
  it.each([
    ['from_file', '42\n'],
    ['rawfile', '"42\\n"\n'],
    ['slurpfile', '[42]\n'],
  ])('reads a dash %s from the backend without a dispatcher', async (option, expected) => {
    const path = new PathSpec({ virtual: '/d/-', directory: '/d', vfsPath: '-', rawPath: '-' })
    const opts = {
      stdin: ENC.encode('99\n'),
      flags: {
        null_input: true,
        compact_output: true,
        [option]: option === 'from_file' ? path : ['x', path],
      },
      cwd: '/d',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await jqGeneric([], ['$x'], opts, read)
    if (result === null) throw new Error('jq returned no result')
    const [out, io] = result
    expect(DEC.decode(await materialize(out))).toBe(expected)
    expect(io.exitCode).toBe(0)
    expect(await materialize(io.stderr)).toEqual(new Uint8Array())
  })

  describe.each(['from_file', 'rawfile', 'slurpfile'])('%s consumes stdin', (option) => {
    describe.each([false, true])('streamed=%s', (streamed) => {
      it.each([null, '-', '/dev/stdin'])('does not replay stdin for input %s', async (operand) => {
        const path = PathSpec.fromStrPath('/dev/stdin')
        const stdin = ENC.encode('99\n')
        const opts = {
          stdin: streamed ? yieldBytes(stdin) : stdin,
          flags: { [option]: option === 'from_file' ? path : ['x', path] },
          cwd: '/',
          vfs: { kind: 'ram' } as never,
        } as CommandOpts
        const paths =
          operand === null
            ? []
            : [
                new PathSpec({
                  virtual: '/dev/stdin',
                  directory: '/dev',
                  vfsPath: 'stdin',
                  rawPath: operand,
                }),
              ]
        const result = await jqGeneric(paths, ['.'], opts, read)
        if (result === null) throw new Error('jq returned no result')
        const [out, io] = result
        expect(await materialize(out)).toEqual(new Uint8Array())
        expect(io.exitCode).toBe(0)
        expect(await materialize(io.stderr)).toEqual(new Uint8Array())
      })
    })
  })
})

describe("jq's option loop", () => {
  it.each([
    ['-x', 'Unknown option -x'],
    ['--indent=3', 'Unknown option --indent=3'],
    ['--arg', '--arg takes two parameters (e.g. --arg varname value)'],
    ['--slurpfile', '--slurpfile takes two parameters (e.g. --slurpfile varname filename)'],
    ['--indent', '--indent takes one parameter'],
  ])('words a refused %s as jq does', (word, line) => {
    expect(optionRefusal(word).message).toBe(`jq: ${line}\n${HINT}`)
  })

  it("prints jq's short usage for an -f the line ends at", () => {
    const refusal = optionRefusal('-f')
    expect(refusal.message.startsWith('jq - commandline JSON processor [version 1.8.2]\n')).toBe(
      true,
    )
    expect(refusal.message.endsWith('For listing the command options, use jq --help.')).toBe(true)
    expect(refusal.exitCode).toBe(2)
  })

  // jq 1.8.2's loop stops at the first word it cannot take, so an option the
  // parser refused waits its turn behind a bad value typed before it.
  it.each([
    [['--indent', 'x', '--argjson', 'a', 'nope', '1'], 'jq: --indent takes'],
    [['--argjson', 'a', 'nope', '--indent', 'x', '1'], 'jq: invalid JSON text'],
    [
      ['--argjson', 'a', 'nope', '--slurpfile', 'b', '/d/missing.json', '1'],
      'jq: invalid JSON text',
    ],
    [
      ['--slurpfile', 'b', '/d/missing.json', '--argjson', 'a', 'nope', '1'],
      'jq: Bad JSON in --slurpfile b /d/missing.json',
    ],
    [['.', '--jsonargs', 'nope', '--indent', 'x'], 'jq: invalid JSON text passed to --jsonargs'],
    [['.', '--indent', 'x', '--jsonargs', 'nope'], 'jq: --indent takes'],
    [
      ['.', '--jsonargs', 'nope', '--argjson', 'a', 'nope'],
      'jq: invalid JSON text passed to --jsonargs',
    ],
    [
      ['.', '--argjson', 'a', 'nope', '--jsonargs', 'nope'],
      'jq: invalid JSON text passed to --argjson',
    ],
    [
      ['.', '--jsonargs', 'nope', '--slurpfile', 'b', '/d/missing.json'],
      'jq: invalid JSON text passed to --jsonargs',
    ],
    [
      ['.', '--slurpfile', 'b', '/d/missing.json', '--jsonargs', 'nope'],
      'jq: Bad JSON in --slurpfile b /d/missing.json',
    ],
    [['.', '--jsonargs', '{', '--bogus'], `jq: invalid JSON text passed to --jsonargs\n${HINT}`],
    [['.', '--bogus', '--jsonargs', '{'], `jq: Unknown option --bogus\n${HINT}`],
    [['.', '--indent', '9', '--bogus'], `jq: --indent takes a number between -1 and 7\n${HINT}`],
    [['.', '--bogus', '--indent', '9'], `jq: Unknown option --bogus\n${HINT}`],
    [['.', '--argjson', 'x', '{', '-Z'], `jq: invalid JSON text passed to --argjson\n${HINT}`],
  ])('reports the first refusal typed in %j', async (words, refusal) => {
    await expect(walkLine(['-n', ...words], (path) => materialize(read(path)))).rejects.toThrow(
      refusal,
    )
  })

  it('answers --help and --version where the loop reaches them', async () => {
    const help = ENC.encode(helpPage('jq', specOf('jq')))
    expect(await walkLine(['--help', '--bogus'], unread)).toEqual(help)
    expect(await walkLine(['-hx'], unread)).toEqual(help)
    expect(await walkLine(['-n', '.', '-V', '--jsonargs', '{'], unread)).toEqual(
      ENC.encode(versionLine('jq')),
    )
    await expect(walkLine(['--bogus', '--help'], unread)).rejects.toThrow('Unknown option --bogus')
    await expect(walkLine(['-n', '.', '--jsonargs', '{', '-V'], unread)).rejects.toThrow(
      'invalid JSON text passed to --jsonargs',
    )
  })

  /** Run a jq line whose -f file is read off FILES. */
  async function ranProgramFile(...words: string[]): Promise<Ran> {
    const opts = {
      stdin: null,
      flags: parsedFlags(...words),
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await jqGeneric([], [], opts, read)
    if (result === null) throw new Error('jq returned no result')
    const [out, io] = result
    return {
      stdout: DEC.decode(await materialize(out)),
      stderr: DEC.decode(await materialize(io.stderr)),
      exitCode: io.exitCode,
    }
  }

  it('reads the program file after the option loop', async () => {
    await expect(ranProgramFile('-n', '-f', '/d/missing.jq', '--bogus')).rejects.toThrow(
      'Unknown option --bogus',
    )
    const missing = await ranProgramFile('-n', '-f', '/d/missing.jq')
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('Could not open')
  })
})

describe('jqGeneric over malformed input', () => {
  it('closes the input it stopped in at a parse error', async () => {
    const closed: string[] = []
    async function* tracked(path: PathSpec): AsyncIterable<Uint8Array> {
      try {
        yield* read(path)
      } finally {
        closed.push(path.virtual)
      }
    }
    const result = await ranOver(['/d/mid.json', '/d/a.json'], '.', {}, tracked)
    expect([result.stdout, result.exitCode]).toEqual(['1\n', 5])
    expect(closed).toEqual(['/d/mid.json'])
  })

  it('reads no further than what input takes', async () => {
    // An input that holds `text` and never ends, like a producer that stays
    // open.
    async function* live(text: string): AsyncIterable<Uint8Array> {
      yield ENC.encode(text)
      await new Promise<never>(() => undefined)
    }
    async function started(
      program: string,
      text: string,
      flags: CommandOpts['flags'],
    ): Promise<[ByteSource | null, IOResult]> {
      const opts = {
        stdin: null,
        flags,
        cwd: '/',
        vfs: { kind: 'ram' } as never,
      } as CommandOpts
      const result = await jqGeneric([PathSpec.fromStrPath('/d/live.json')], [program], opts, () =>
        live(text),
      )
      if (result === null) throw new Error('jq returned no result')
      return result
    }
    function soon<T>(promise: Promise<T>): Promise<T | 'still waiting'> {
      return Promise.race([
        promise,
        new Promise<'still waiting'>((resolve) => {
          setTimeout(() => {
            resolve('still waiting')
          }, 5000).unref()
        }),
      ])
    }
    const [lone, io] = await started('input', '[1 2]\n', { null_input: true })
    expect(await soon(materialize(lone))).toEqual(new Uint8Array(0))
    expect([DEC.decode(await materialize(io.stderr)), io.exitCode]).toEqual([
      'jq: error (at /d/live.json:1): Expected separator between values at line 1, column 5\n',
      5,
    ])
    const [pairs] = await started('[., input]', '1\n2\n', { compact_output: true })
    if (pairs === null || pairs instanceof Uint8Array) throw new Error('jq did not stream')
    const first = await soon(pairs[Symbol.asyncIterator]().next())
    if (first === 'still waiting' || first.done === true) {
      throw new Error('jq waited on the rest of the input')
    }
    expect(DEC.decode(first.value)).toBe('[1,2]\n')
  })

  it('refuses a --slurpfile holding bad JSON in jq words', async () => {
    await expect(
      ran('/d/four.json', '$x', { null_input: true, slurpfile: ['x', '/d/bad.json'] }),
    ).rejects.toThrow(
      'jq: Bad JSON in --slurpfile x /d/bad.json: Unfinished JSON term at EOF at line 3, column 1',
    )
  })
})

describe('jqGeneric over an input it cannot read', () => {
  it.each([
    ['rawfile', '/d/nope.json', 'No such file or directory'],
    ['slurpfile', '/d/nope.json', 'No such file or directory'],
    ['rawfile', '/d/dir', "It's a directory"],
    ['slurpfile', '/d/dir', "It's a directory"],
  ])("refuses a --%s file it cannot read (%s) in jq's words", async (option, path, reason) => {
    await expect(
      ranOver([], '$x', { null_input: true, [option]: ['x', path] }),
    ).rejects.toMatchObject({
      message: `jq: Bad JSON in --${option} x ${path}: Could not open ${path}: ${reason}`,
      exitCode: 2,
    })
  })
})

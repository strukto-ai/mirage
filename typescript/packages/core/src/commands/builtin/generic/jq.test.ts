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

import { describe, expect, it, vi } from 'vitest'
import * as rs from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { yieldBytes } from '../../../io/stream.ts'
import { materialize, type ByteSource, type IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir, enoent } from '../../../errors/fs.ts'
import { type Context } from '../../config.ts'
import { helpPage, versionLine } from '../../spec/standard.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'
import { inputName, jqGeneric, optionTape } from './jq.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/d/four.json': '1\n2\n3\n4\n',
  '/d/a.json': '{"a":1}\n',
  '/d/b.json': '{"b":2}\n',
  '/d/bad.json': '{"a":1}\n{"a":2}\n[',
  '/d/mid.json': '1\n[1 2]\n3\n4\n',
  '/d/one.json': '1',
  '/d/one-two.json': '1 2',
  '/d/two.json': ' 2\n',
  '/d/-': '42\n',
  '/d/spelled.json': '{"b":1.000,"1":2}',
  '/d/origin.jq': '[get_prog_origin, get_jq_origin]',
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
  flags: Context['flags'] = {},
  stream: typeof read = read,
  signal?: AbortSignal,
): Promise<Ran> {
  const ctx = {
    stdin: null,
    flags: { compact_output: true, ...flags },
    cwd: PathSpec.fromStrPath('/'),
    signal,
  } as Context
  const specs = paths.map((path) => PathSpec.fromStrPath(path))
  const result = await jqGeneric(specs, [program], ctx, stream)
  if (result === null) throw new Error('jq returned no result')
  const [out, io] = result
  return {
    stdout: DEC.decode(await materialize(out)),
    stderr: DEC.decode(await materialize(io.stderr)),
    exitCode: io.exitCode,
  }
}

/** Run jq over one file and return what it printed and how it exited. */
async function ran(path: string, program: string, flags: Context['flags'] = {}): Promise<Ran> {
  return ranOver([path], program, flags)
}

const HINT =
  'Use jq --help for help with command-line options,\n' +
  'or see the jq manpage, or online docs at https://jqlang.org'

/** A jq line's flags as the parser leaves them, with the order they were typed in. */
function parsedFlags(...words: string[]): Context['flags'] {
  return parseToKwargs(parseCommand(specOf('jq'), words, '/', 'jq'))
}

function unread(path: PathSpec): AsyncIterable<Uint8Array> {
  throw new Error(`${path.virtual} should not be read`)
}

/** Run a jq line as the parser reads it, its files read with `stream`. */
async function ranLine(words: readonly string[], stream: typeof read = read): Promise<Ran> {
  const parsed = parseCommand(specOf('jq'), [...words], '/', 'jq')
  const ctx = {
    stdin: null,
    flags: parseToKwargs(parsed),
    cwd: PathSpec.fromStrPath('/'),
  } as Context
  const result = await jqGeneric([], parsed.texts(), ctx, stream)
  if (result === null) throw new Error('jq returned no result')
  const [out, io] = result
  return {
    stdout: DEC.decode(await materialize(out)),
    stderr: DEC.decode(await materialize(io.stderr)),
    exitCode: io.exitCode,
  }
}

describe('optionTape', () => {
  it('takes bindings from the bag and names files as typed', () => {
    const typed = new PathSpec({
      virtual: '/d/one.json',
      directory: '/d/',
      vfsPath: 'd/one.json',
      rawPath: 'one.json',
    })
    const program = new PathSpec({
      virtual: '/d/p.jq',
      directory: '/d/',
      vfsPath: 'd/p.jq',
      rawPath: 'p.jq',
    })
    const parsed = parseCommand(
      specOf('jq'),
      ['-n', '--arg', 'a', '1', '--rawfile', 'r', 'x', '-f', 'p', '--args'],
      '/',
      'jq',
    )
    const flags = parseToKwargs(parsed) as Context['flags']
    flags.rawfile = ['r', typed]
    flags.from_file = program
    const [tape, files] = optionTape(new FlagView(flags, specOf('jq')), parsed.texts())
    expect(tape).toEqual([
      ['null_input', ''],
      ['arg', 'a'],
      ['arg', '1'],
      ['rawfile', 'r'],
      ['rawfile', 'one.json'],
      ['from_file', 'p.jq'],
      ['args', ''],
    ])
    expect(files).toEqual(
      new Map([
        [4, typed],
        [5, program],
      ]),
    )
  })

  it('puts keyword operands after every option', () => {
    const fl = new FlagView(
      { args: true, null_input: false, slurpfile: ['s', '/d/a'] },
      specOf('jq'),
    )
    const [tape, files] = optionTape(fl, ['.', 'a'])
    expect(tape).toEqual([
      ['args', ''],
      ['slurpfile', 's'],
      ['slurpfile', '/d/a'],
      ['', '.'],
      ['', 'a'],
    ])
    expect(files.get(2)?.virtual).toBe('/d/a')
  })
})

describe("jq's option loop", () => {
  it.each([
    [['--indent', '-1'], '{\n\t"a": [\n\t\t1\n\t]\n}\n'],
    [['-c', '--indent', '1'], '{\n "a": [\n  1\n ]\n}\n'],
    [['--indent', '1', '-c'], '{"a":[1]}\n'],
    [['--tab', '-j'], '{\n\t"a": [\n\t\t1\n\t]\n}'],
  ])('prints the layout %j decides', async (words, stdout) => {
    expect(await ranLine(['-n', ...words, '{a: [1]}'])).toEqual({ stdout, stderr: '', exitCode: 0 })
  })

  it('hands the program its bindings in the order typed', async () => {
    const result = await ranLine([
      '-nc',
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
      '{"x":1.000}',
      '--slurpfile',
      's',
      '/d/missing.json',
      '$ARGS.named, $b',
    ])
    expect(result).toEqual({
      stdout: '{"s":[1,2,3,4],"a":"1","r":"1","b":{"x":1.000}}\n{"x":1.000}\n',
      stderr: '',
      exitCode: 0,
    })
  })

  it('never reads a binding of a taken name', async () => {
    const result = await ranLine(
      ['-n', '--arg', 'v', '1', '--slurpfile', 'v', '/d/four.json', '$v'],
      unread,
    )
    expect(result).toEqual({ stdout: '"1"\n', stderr: '', exitCode: 0 })
  })

  it('files the operands after --args and --jsonargs as positional', async () => {
    const result = await ranLine([
      '-nc',
      '$ARGS.positional',
      '/d/a.json',
      '--args',
      'x',
      '--jsonargs',
      '{"b":1.0}',
    ])
    expect(result).toEqual({ stdout: '["x",{"b":1.0}]\n', stderr: '', exitCode: 0 })
    const ctx = {
      stdin: null,
      flags: { null_input: true, args: true },
      cwd: PathSpec.fromStrPath('/'),
    } as Context
    const keyword = await jqGeneric([], ['.', 'a'], ctx, read)
    if (keyword === null) throw new Error('jq returned no result')
    expect(DEC.decode(await materialize(keyword[0]))).toBe('null\n')
  })

  it.each([
    [
      ['--slurpfile', 'x', '/d/bad.json'],
      'jq: Bad JSON in --slurpfile x /d/bad.json: Unfinished JSON term at EOF at line 3, column 1\n',
    ],
    [
      ['--rawfile', 'x', '/d/nope.json'],
      'jq: Bad JSON in --rawfile x /d/nope.json: Could not open /d/nope.json: No such file or directory\n',
    ],
    [
      ['--slurpfile', 'x', '/d/dir'],
      "jq: Bad JSON in --slurpfile x /d/dir: Could not open /d/dir: It's a directory\n",
    ],
    [
      ['--slurpfile', 'x', '/d/nope.json', '--indent', '9'],
      'jq: Bad JSON in --slurpfile x /d/nope.json: Could not open /d/nope.json: No such file or directory\n',
    ],
    [
      ['--indent', '9', '--slurpfile', 'x', '/d/nope.json'],
      `jq: --indent takes a number between -1 and 7\n${HINT}\n`,
    ],
    [['--argjson', 'x', '{', '--bogus'], `jq: invalid JSON text passed to --argjson\n${HINT}\n`],
    [['--bogus'], `jq: Unknown option --bogus\n${HINT}\n`],
  ])('reports the first refusal typed in %j', async (words, stderr) => {
    expect(await ranLine(['-n', ...words, '$x'])).toEqual({ stdout: '', stderr, exitCode: 2 })
  })

  it('answers --help and --version where the loop reaches them', async () => {
    const help = { stdout: helpPage('jq', specOf('jq')), stderr: '', exitCode: 0 }
    expect(await ranLine(['--help', '--bogus'])).toEqual(help)
    expect(await ranLine(['-hx'])).toEqual(help)
    expect(await ranLine(['-n', '.', '-V', '--jsonargs', '{'])).toEqual({
      stdout: versionLine('jq'),
      stderr: '',
      exitCode: 0,
    })
    const refused = await ranLine(['--bogus', '--help'])
    expect([refused.stderr.startsWith('jq: Unknown option --bogus'), refused.exitCode]).toEqual([
      true,
      2,
    ])
  })

  it('reads the program file after the option loop', async () => {
    const refused = await ranLine(['-n', '-f', '/d/missing.jq', '--bogus'])
    expect([refused.stderr.startsWith('jq: Unknown option --bogus'), refused.exitCode]).toEqual([
      true,
      2,
    ])
    const missing = await ranLine(['-n', '-f', '/d/missing.jq'])
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('Could not open')
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

describe('jq flag-file readers', () => {
  it.each([
    ['from_file', '42\n'],
    ['rawfile', '"42\\n"\n'],
    ['slurpfile', '[42]\n'],
  ])('reads a dash %s from the backend without a dispatcher', async (option, expected) => {
    const path = new PathSpec({ virtual: '/d/-', directory: '/d', vfsPath: '-', rawPath: '-' })
    const ctx = {
      stdin: ENC.encode('99\n'),
      flags: {
        null_input: true,
        compact_output: true,
        [option]: option === 'from_file' ? path : ['x', path],
      },
      cwd: PathSpec.fromStrPath('/d'),
    } as Context
    const result = await jqGeneric([], ['$x'], ctx, read)
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
        const ctx = {
          stdin: streamed ? yieldBytes(stdin) : stdin,
          flags: { [option]: option === 'from_file' ? path : ['x', path] },
          cwd: PathSpec.fromStrPath('/'),
        } as Context
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
        const result = await jqGeneric(paths, ['.'], ctx, read)
        if (result === null) throw new Error('jq returned no result')
        const [out, io] = result
        expect(await materialize(out)).toEqual(new Uint8Array())
        expect(io.exitCode).toBe(0)
        expect(await materialize(io.stderr)).toEqual(new Uint8Array())
      })
    })
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
      flags: Context['flags'],
    ): Promise<[ByteSource | null, IOResult]> {
      const ctx = {
        stdin: null,
        flags,
        cwd: PathSpec.fromStrPath('/'),
      } as Context
      const result = await jqGeneric([PathSpec.fromStrPath('/d/live.json')], [program], ctx, () =>
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
})

describe('jq_eval', () => {
  it.each([
    ['[., input]', {}, '[1,2]\n[3,4]\n', '', 0],
    ['first(inputs)', {}, '2\n4\n', '', 0],
    ['if . == 1 then [., input] else . end', {}, '[1,2]\n3\n4\n', '', 0],
    ['[., input, input]', {}, '[1,2,3]\n', 'jq: error (at /d/four.json:4): break\n', 5],
    ['[input_filename, input_line_number]', { null_input: true }, '[null,0]\n', '', 0],
    ['[inputs] | length', { null_input: true }, '4\n', '', 0],
  ] as const)(
    'takes each document when %s asks for it',
    async (program, flags, stdout, stderr, exitCode) => {
      expect(await ran('/d/four.json', program, flags)).toEqual({ stdout, stderr, exitCode })
    },
  )

  it('meets a parse error and follows the reader position in input', async () => {
    expect(await ran('/d/mid.json', '[., input]')).toEqual({
      stdout: '[3,4]\n',
      stderr:
        'jq: error (at /d/mid.json:2): Expected separator between values at line 2, column 5\n',
      exitCode: 0,
    })
    const result = await ranOver(
      ['/d/a.json', '/d/b.json'],
      '[., input_filename, input_line_number, input, input_filename]',
    )
    expect(result.stdout).toBe('[{"a":1},"/d/a.json",1,{"b":2},"/d/b.json"]\n')
  })

  it('writes debug and stderr lines before the run report', async () => {
    const result = await ranOver(
      [],
      '{"b":1,"a":2} | (debug | empty), ("x" | stderr | empty), ({"c":3} | stderr | error)',
      { null_input: true, sort_keys: true },
    )
    expect(result).toEqual({
      stdout: '',
      stderr:
        '["DEBUG:",{"a":2,"b":1}]\n' + 'x{"c":3}jq: error (at <unknown>) (not a string): {"c":3}\n',
      exitCode: 5,
    })
  })

  it.each([
    ['[$ENV.HOME, env.HOME, ($ENV | length)]', '["/home/agent","/home/agent",1]\n'],
    [
      '[$ENV.HOME, env.HOME, ($ENV | length), (now | type)]',
      '["/home/agent","/home/agent",1,"number"]\n',
    ],
  ])("reads the session's exported environment in %s", async (program, stdout) => {
    const ctx = {
      stdin: null,
      flags: { compact_output: true, null_input: true },
      cwd: PathSpec.fromStrPath('/'),
      env: { HOME: '/home/agent' },
    } as Context
    const result = await jqGeneric([], [program], ctx, read)
    if (result === null) throw new Error('jq returned no result')
    expect(DEC.decode(await materialize(result[0]))).toBe(stdout)
    expect((await ranOver([], '$ENV', { null_input: true })).stdout).toBe('{}\n')
  })

  it('stops a program that never ends when its signal aborts', async () => {
    const started = Date.now()
    await expect(
      ranOver([], 'until(false; .)', { null_input: true }, read, AbortSignal.timeout(200)),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await ran('/d/one.json', '. + 1')).stdout).toBe('2\n')
  })

  it('runs math builtins in jq_eval', async () => {
    const result = await ranOver([], '5 | tgamma, (4 | lgamma_r)', { null_input: true })
    expect(result).toEqual({ stdout: '24\n[1.791759469228055,1]\n', stderr: '', exitCode: 0 })
  })

  it('keeps the spelling jq gives each output', async () => {
    expect(await ran('/d/spelled.json', '., .b, (.b + 0), (1e17 * 1), -0, keys_unsorted')).toEqual({
      stdout: '{"b":1.000,"1":2}\n1.000\n1\n1e+17\n0\n["b","1"]\n',
      stderr: '',
      exitCode: 0,
    })
  })

  it('runs dates, the clock and a rule zone in jq_eval', async () => {
    const saved = process.env.TZ
    process.env.TZ = 'EST5EDT,M3.2.0,M11.1.0'
    try {
      const result = await ranOver([], '1425599507 | todate, (localtime | .[3]), (now | type)', {
        null_input: true,
      })
      expect(result).toEqual({
        stdout: '"2015-03-05T23:51:47Z"\n18\n"number"\n',
        stderr: '',
        exitCode: 0,
      })
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it("answers get_prog_origin with the program file's directory, else the cwd", async () => {
    const program = '[get_prog_origin, get_jq_origin]'
    const ctx = {
      stdin: null,
      flags: parsedFlags('-c', '-n', program),
      cwd: PathSpec.fromStrPath('/d/dir'),
    } as Context
    const result = await jqGeneric([], [program], ctx, read)
    if (result === null) throw new Error('jq returned no result')
    expect(DEC.decode(await materialize(result[0]))).toBe('["/d/dir","."]\n')
    const fromFile = {
      stdin: null,
      flags: parsedFlags('-c', '-n', '-f', '/d/origin.jq'),
      cwd: PathSpec.fromStrPath('/'),
    } as Context
    const ranFile = await jqGeneric([], [], fromFile, read)
    if (ranFile === null) throw new Error('jq returned no result')
    expect(DEC.decode(await materialize(ranFile[0]))).toBe('["/d","."]\n')
  })

  it('reports a program jq refuses as jq does', async () => {
    expect(await ranOver([], '  $x | nosuch(1) +', { null_input: true })).toEqual({
      stdout: '',
      stderr:
        'jq: error: syntax error, unexpected end of file at <top-level>, line 1, column 18:\n' +
        '      $x | nosuch(1) +\n' +
        '                     ^\n' +
        'jq: 1 compile error\n',
      exitCode: 3,
    })
    expect((await ranOver([], '$x | nosuch(1)', { null_input: true })).stderr).toBe(
      'jq: error: $x is not defined at <top-level>, line 1, column 1:\n' +
        '    $x | nosuch(1)\n' +
        '    ^^\n' +
        'jq: error: nosuch/1 is not defined at <top-level>, line 1, column 6:\n' +
        '    $x | nosuch(1)\n' +
        '         ^^^^^^\n' +
        'jq: 2 compile errors\n',
    )
  })
})

describe('jq_eval clock', () => {
  it('reads the clock at each call of now', async () => {
    const result = await ranOver([], 'now as $s | until(now > $s; .) | "done"', {
      null_input: true,
    })
    expect(result).toEqual({ stdout: '"done"\n', stderr: '', exitCode: 0 })
  })
})

describe('local time', () => {
  it("reads the session's zone from the tz database", async () => {
    const saved = process.env.TZ
    process.env.TZ = '/usr/share/zoneinfo/Europe/Paris'
    const program =
      '1690000000 | strflocaltime("%H:%M %Z %z"), strftime("%Z"), ' +
      '(1 | debug | (0 | localtime) | .[3])'
    try {
      expect(await ranOver([], program, { null_input: true })).toEqual({
        stdout: '"06:26 CEST +0200"\n"GMT"\n1\n',
        stderr: '["DEBUG:",1]\n',
        exitCode: 0,
      })
      const ctx = {
        stdin: null,
        flags: { compact_output: true, null_input: true },
        cwd: PathSpec.fromStrPath('/'),
        env: { TZ: 'Asia/Kolkata' },
      } as Context
      const result = await jqGeneric([], [program], ctx, read)
      if (result === null) throw new Error('jq returned no result')
      expect(DEC.decode(await materialize(result[0]))).toBe('"09:56 IST +0530"\n"GMT"\n5\n')
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })
})

describe('jq refusals', () => {
  it('does not read on after a refused read', async () => {
    const open = rs.openStream
    const message = 'reply fixture'
    const patched = vi.spyOn(rs, 'openStream').mockImplementation(async (kind, config) => {
      const stream = await open(kind, config)
      if (kind === 'jq') {
        vi.spyOn(stream, 'respond').mockImplementation(() => {
          throw new StreamRefusal(message, new Uint8Array())
        })
      }
      return stream
    })
    try {
      await expect(ranOver(['/d/one.json'], 'input', { null_input: true })).rejects.toThrow(message)
    } finally {
      patched.mockRestore()
    }
  })

  it('rejects an unknown request without reading input', async () => {
    const open = rs.openStream
    const patched = vi.spyOn(rs, 'openStream').mockImplementation(async (kind, config) => {
      const stream = await open(kind, config)
      if (kind === 'jq') {
        vi.spyOn(stream, 'request').mockReturnValue([{ op: 'unknown-fixture' }, new Uint8Array()])
      }
      return stream
    })
    let reads = 0
    async function* read(): AsyncIterable<Uint8Array> {
      reads += 1
      yield* yieldBytes(ENC.encode('1'))
    }
    try {
      await expect(ranOver(['/d/one.json'], 'input', { null_input: true }, read)).rejects.toThrow(
        'unknown host request',
      )
      expect(reads).toBe(0)
    } finally {
      patched.mockRestore()
    }
  })
})

describe('outputs as a run makes them', () => {
  it('writes an output before its run ends, and closing the output ends the run', async () => {
    const ctx = {
      stdin: null,
      flags: { null_input: true },
      cwd: PathSpec.fromStrPath('/'),
    } as Context
    const result = await jqGeneric([], ['0, until(false; .)'], ctx, read)
    if (result === null) throw new Error('jq returned no result')
    const [out] = result
    if (out === null || out instanceof Uint8Array) throw new Error('jq returned no stream')
    const chunks = out[Symbol.asyncIterator]()
    const first = await chunks.next()
    expect(first.done).toBe(false)
    expect(DEC.decode(first.value as Uint8Array)).toBe('0\n')
    await chunks.return?.()
  })

  it('stops a run at an output --raw-output0 cannot print, and runs the next', async () => {
    // Pinned to jq 1.8.2: printf '1 2' | jq --raw-output0 'if . == 1 then
    // "x", "a\u0000b", (1 | debug), "y" else "c" end' prints x, refuses the
    // NUL string, leaves the debug line and y unwritten, and runs the second
    // document, whose run settles the exit status.
    expect(
      await ranOver(
        ['/d/one-two.json'],
        'if . == 1 then "x", "a\\u0000b", (1 | debug), "y" else "c" end',
        { raw_output0: true },
      ),
    ).toEqual({
      stdout: 'x\0c\0',
      stderr:
        'jq: error (at /d/one-two.json:0): Cannot dump a string containing NUL with' +
        ' --raw-output0 option\n',
      exitCode: 0,
    })
  })
})

describe('jq cleanup', () => {
  it('closes the inputs and the stream when the stderr spool fails', async () => {
    const appends = new Map<ByteSpool, number>()
    const spool = vi.spyOn(ByteSpool.prototype, 'append').mockImplementation(function (
      this: ByteSpool,
    ) {
      const count = (appends.get(this) ?? 0) + 1
      appends.set(this, count)
      if (count >= 3) return Promise.reject(new Error('No space left on device'))
      return Promise.resolve()
    })
    const release = vi.spyOn(rs, 'closeStream')
    let finished = 0
    async function* endless(): AsyncIterable<Uint8Array> {
      try {
        for (let i = 0; i < 1000; i++) {
          await Promise.resolve()
          yield ENC.encode('1 ')
        }
      } finally {
        finished += 1
      }
    }
    try {
      await expect(ranOver(['/d/one.json'], '.', {}, endless)).rejects.toThrow('No space left')
      // The option loop's stream, the compile check's and the run's, and the
      // input.
      expect(release).toHaveBeenCalledTimes(3)
      expect(finished).toBe(1)
    } finally {
      spool.mockRestore()
      release.mockRestore()
    }
  })
})

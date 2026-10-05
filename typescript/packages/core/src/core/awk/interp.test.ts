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
import { AwkIOError, AwkRuntimeError } from './errors.ts'
import { ExitProgram, Interpreter } from './interp.ts'
import { parse } from './parser.ts'
import type { AwkHost, CommandRun } from './types.ts'
import { text } from './value.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const DATA = ['alice 30 eng', 'bob 25 ops', 'carol 41 eng', 'dave 19 ops']

type Command = (stdin: Uint8Array | null) => CommandRun

/** An in-memory world: files by name, commands by line, one stdin. */
class FakeHost implements AwkHost {
  readonly files: Map<string, string>
  readonly commands: Record<string, Command>
  readonly stdin: Uint8Array[]
  readonly runs: [string, Uint8Array | null][] = []

  constructor(
    files: Record<string, string> = {},
    commands: Record<string, Command> = {},
    stdin = '',
  ) {
    this.files = new Map(Object.entries(files))
    this.commands = commands
    this.stdin = stdin === '' ? [] : [ENC.encode(stdin)]
  }

  openInput(name: string): AsyncIterable<Uint8Array> {
    return this.stream(name)
  }

  private async *stream(name: string): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    if (name === '-' || name === '/dev/stdin') {
      for (;;) {
        const chunk = this.stdin.shift()
        if (chunk === undefined) return
        yield chunk
      }
    }
    const body = this.files.get(name)
    if (body === undefined) throw new AwkIOError('No such file or directory')
    yield ENC.encode(body)
  }

  writeFile(name: string, body: string, append: boolean): Promise<void> {
    if (name.startsWith('/ro/')) return Promise.reject(new AwkIOError('Read-only file system'))
    this.files.set(name, (append ? (this.files.get(name) ?? '') : '') + body)
    return Promise.resolve()
  }

  run(command: string, stdin: Uint8Array | null): Promise<CommandRun> {
    this.runs.push([command, stdin])
    const fn = this.commands[command]
    if (fn === undefined) throw new Error(`no fake command ${command}`)
    return Promise.resolve(fn(stdin))
  }
}

function echo(out: string, status = 0, err = ''): Command {
  return () => ({ stdout: ENC.encode(out), stderr: ENC.encode(err), status })
}

function cat(stdin: Uint8Array | null): CommandRun {
  return { stdout: stdin ?? new Uint8Array(0), stderr: new Uint8Array(0), status: 0 }
}

async function execute(
  program: string,
  host: FakeHost,
  argv: string[] = [],
  fs?: string,
  assignments: Record<string, string> = {},
): Promise<[string, string]> {
  const interp = new Interpreter(parse(program), host, argv, assignments)
  if (fs !== undefined) interp.setVar('FS', text(fs))
  try {
    await interp.runBegin()
    if (interp.hasMainRules()) {
      for (;;) {
        const record = await interp.nextRecord()
        if (record === null) break
        await interp.runRecord(record)
      }
    }
    await interp.runEnd()
  } catch (err) {
    if (!(err instanceof ExitProgram)) throw err
  }
  await interp.finish()
  const [out, err] = await interp.drain()
  return [DEC.decode(out), DEC.decode(err)]
}

interface RunOpts {
  lines?: string[]
  fs?: string
  assignments?: Record<string, string>
}

async function run(program: string, o: RunOpts = {}): Promise<string> {
  const stdin = (o.lines ?? []).map((line) => `${line}\n`).join('')
  const [out] = await execute(program, new FakeHost({}, {}, stdin), [], o.fs, o.assignments)
  return out
}

async function fatal(step: Promise<unknown>): Promise<AwkRuntimeError> {
  try {
    await step
  } catch (err) {
    if (err instanceof AwkRuntimeError) return err
    throw err
  }
  throw new Error('expected a fatal error')
}

const GETLINE_FILES: Record<string, string> = {
  g: 'a\nb\n',
  p: 'a\nb\n\nc\n',
  r: 'a1b2c',
  c: 'x:y:z\n',
  n: '10\n',
}

describe('awk interpreter', () => {
  it('builds an indent in a for loop', async () => {
    const program = '{indent="";for(i=1;i<NF;i++)indent=indent"    ";print indent $NF}'
    const lines = ['School/Courses_Materials/notes.md', 'top.txt']
    expect(await run(program, { lines, fs: '/' })).toBe('        notes.md\ntop.txt\n')
  })

  it('splits fields at newlines too in paragraph mode', async () => {
    const lines = ['a:b\nc']
    expect(await run('{print NF}', { lines, fs: ':', assignments: { RS: '' } })).toBe('3\n')
    expect(await run('{print NF}', { lines, fs: ':' })).toBe('2\n1\n')
    expect(await run('{RS=""; print NF}', { lines: ['a:b\nc\n', 'd:e\nf'], fs: ':' })).toBe(
      '2\n1\n3\n',
    )
  })

  it.each([
    ['{s+=$2} END{print s, s/NR}', '115 28.75\n'],
    ['$2 > 26 {print $1}', 'alice\ncarol\n'],
    ['NR==2,NR==3 {print $1}', 'bob\ncarol\n'],
    ['!seen[$3]++', 'alice 30 eng\nbob 25 ops\n'],
    ['$3=="ops"{next} {print $1}', 'alice\ncarol\n'],
    ['NR==1||$2>max{max=$2; who=$1} END{print who, max}', 'carol 41\n'],
    ['{c[$3]++} END{print c["eng"], c["ops"], length(c)}', '2 2 2\n'],
    ['END{print NR, $0}', '4 dave 19 ops\n'],
  ])('runs %j over records', async (program, expected) => {
    expect(await run(program, { lines: DATA })).toBe(expected)
  })

  it.each([
    ['BEGIN{print 7/2, 7%3, 2^10, -2^2, 0.1+0.2, 1/3}', '3.5 1 1024 -4 0.3 0.333333\n'],
    ['BEGIN{i=5; print i++, i, ++i, i--, --i}', '5 6 7 7 5\n'],
    // A float assignment in BEGIN, which the scraper this replaced
    // refused as an unsupported construct.
    ['BEGIN {a=7*7.172100067138672; print a}', '50.2047\n'],
    ['BEGIN{x=1; y=2; print x y, x+y, x" "y}', '12 3 1 2\n'],
    ['BEGIN{print x+0, "[" x "]", (x==0), (x=="")}', '0 [] 1 1\n'],
    ['BEGIN{print ("10"<"9"), (10<9), ("abc"<1)}', '1 0 0\n'],
    ['BEGIN{while(i<5){i++; if(i==2)continue; if(i==4)break; print i}}', '1\n3\n'],
    ['BEGIN{do{print i++}while(i<3)}', '0\n1\n2\n'],
    ['BEGIN{for(;;){if(++n>3)break}; print n}', '4\n'],
    ['BEGIN{a[1,2]=3; for(k in a){split(k,p,SUBSEP); print p[1],p[2]}}', '1 2\n'],
    ['BEGIN{a["x"]; delete a["x"]; print ("x" in a), length(a)}', '0 0\n'],
    ['BEGIN{n=split("c a b",q); for(i=1;i<=n;i++)printf "%s.",q[i]}', 'c.a.b.'],
    ['function fact(n){return n<=1?1:n*fact(n-1)} BEGIN{print fact(10)}', '3628800\n'],
    [
      'function fill(arr,n,  i){for(i=1;i<=n;i++)arr[i]=i*i} BEGIN{fill(sq,3); print sq[3], length(sq)}',
      '9 3\n',
    ],
    ['function f(x){x=5} BEGIN{y=1; f(y); print y}', '1\n'],
    ['BEGIN{OFMT="%.2f"; x=3.14159; print x, x""}', '3.14 3.14159\n'],
    ['BEGIN{print length("héllo"), toupper("abc"), index("hello","ll")}', '6 ABC 3\n'],
    ['BEGIN{print match("foobar",/o+/), RSTART, RLENGTH}', '2 2 2\n'],
    ['BEGIN{srand(1); a=rand(); srand(1); print (a==rand()), (a<1)}', '1 1\n'],
    ['BEGIN{a[10]; a[9]; a["x"]; for(k in a)printf "%s ", k}', '10 9 x '],
  ])('runs %j', async (program, expected) => {
    expect(await run(program)).toBe(expected)
  })

  it('rebuilds the record on a field assignment', async () => {
    expect(await run('{$2="X"; print; print NF}', { lines: ['a b c'] })).toBe('a X c\n3\n')
    expect(await run('{NF=2; print}', { lines: ['a b c'] })).toBe('a b\n')
    expect(await run('{$5="e"; print; print NF}', { lines: ['a b'] })).toBe('a b   e\n5\n')
    expect(await run('BEGIN{OFS="-"} {$1=$1; print}', { lines: ['a b c'] })).toBe('a-b-c\n')
  })

  it('applies an FS assigned in an action from the next record', async () => {
    expect(await run('{FS=":"; print $1}', { lines: ['a:b c', 'd:e f'] })).toBe('a:b\nd\n')
  })

  it('compares strnum fields numerically', async () => {
    expect(await run('{print ($1==10), ($1=="10"), ($3==0)}', { lines: ['10.0 x'] })).toBe(
      '1 0 0\n',
    )
  })

  it('reads a command-line assignment as a strnum', async () => {
    expect(await run('BEGIN{print n+1, (n==5)}', { assignments: { n: '5' } })).toBe('6 1\n')
  })

  it('holds the environment in ENVIRON as strnums', async () => {
    const interp = new Interpreter(
      parse('BEGIN{print ENVIRON["n"]+1, (ENVIRON["n"]==5), ("m" in ENVIRON)}'),
      new FakeHost(),
      [],
      {},
      { n: '05' },
    )
    await interp.runBegin()
    expect(DEC.decode((await interp.drain())[0])).toBe('6 1 0\n')
  })

  it('carries the exit code and still runs END', async () => {
    const interp = new Interpreter(
      parse('NR==2{exit 3} {print} END{print "end"}'),
      new FakeHost({}, {}, 'a\nb\nc\n'),
    )
    await interp.runRecord((await interp.nextRecord()) ?? '')
    let code = -1
    try {
      await interp.runRecord((await interp.nextRecord()) ?? '')
    } catch (err) {
      if (!(err instanceof ExitProgram)) throw err
      code = err.code
    }
    expect(code).toBe(3)
    await interp.runEnd()
    expect(DEC.decode((await interp.drain())[0])).toBe('a\nend\n')
  })

  it('moves to the next operand on nextfile', async () => {
    const host = new FakeHost({ 'a.txt': 'one\ntwo\n', 'b.txt': 'three\n' })
    const [out] = await execute('{print FILENAME, $0; nextfile}', host, ['a.txt', 'b.txt'])
    expect(out).toBe('a.txt one\nb.txt three\n')
  })

  it('restarts FNR and sets FILENAME per file', async () => {
    const host = new FakeHost({ 'a.txt': 'x\n', 'b.txt': 'y\n' })
    const [out] = await execute('{print FILENAME, NR, FNR}', host, ['a.txt', 'b.txt'])
    expect(out).toBe('a.txt 1 1\nb.txt 2 1\n')
  })

  it('names stdin -', async () => {
    const [out] = await execute(
      'BEGIN{printf "[%s]", FILENAME} {print FILENAME}',
      new FakeHost({}, {}, 's\n'),
    )
    expect(out).toBe('[]-\n')
  })

  it('keeps /dev/stderr apart', async () => {
    const result = await execute('{print "w" > "/dev/stderr"; print}', new FakeHost({}, {}, 'a\n'))
    expect(result).toEqual(['a\n', 'w\n'])
  })

  it.each([
    ['NR==1{getline; print}', 'b\n'],
    ['{print} NR==2{getline x}', 'a\nb\n'],
    ['NR==1{getline v; print v, NR, FNR, NF, $0}', 'b 2 2 1 a\n'],
    ['{r=getline; print r, $0, NR}', '1 b 2\n0 c 3\n'],
    ['END{r=getline; print r, $0, NR}', '0 c 3\n'],
    ['BEGIN{getline; print "B", $0, NR} {print "M", $0, NR}', 'B a 1\nM b 2\nM c 3\n'],
    ['NR==1{while ((getline l) > 0) last=l} END{print last, NR, $0}', 'c 3 a\n'],
    ['{ print (getline) (getline) }', '11\n'],
  ])('reads the main input with a plain %j', async (program, expected) => {
    expect(await run(program, { lines: ['a', 'b', 'c'] })).toBe(expected)
  })

  it('crosses operands and assignments with a plain getline', async () => {
    const host = new FakeHost({ f1: '1\n', f2: '2\n3\n' })
    const [out] = await execute(
      '{print "rec", $0; while ((getline l) > 0) print "got", l, x, FILENAME, FNR, NR}',
      host,
      ['f1', 'x=5', 'f2'],
    )
    expect(out).toBe('rec 1\ngot 2 5 f2 1 2\ngot 3 5 f2 2 3\n')
  })

  it.each([
    [['x=1', 'f1', 'x=2', 'f2'], '{print x}', '1\n2\n2\n'],
    [['f1', 'x=7'], 'END{print x}', '7\n'],
    [['x=a\\tb', 'f1'], '{print x}', 'a\tb\n'],
    [['x=010', 'f1'], '{print x+0, (x < 9)}', '10 0\n'],
    [['f1', 'x=1'], 'BEGIN{for(i=0;i<ARGC;i++) print i, ARGV[i]}', '0 awk\n1 f1\n2 x=1\n'],
    [['f1', 'f2'], 'BEGIN{ARGV[1]=""} {print}', '2\n3\n'],
    [['f1'], 'BEGIN{ARGV[1]="f2"} {print FILENAME, $0}', 'f2 2\nf2 3\n'],
    [['f1'], 'BEGIN{ARGV[ARGC++]="f2"} {print}', '1\n2\n3\n'],
    [['f1', 'f2'], 'BEGIN{ARGC=2} {print}', '1\n'],
    [['f1', 'f2'], 'BEGIN{delete ARGV[1]} {print}', '2\n3\n'],
    [['f1', 'f2'], 'BEGIN{ARGV[1]="x=9"} {print x, $0}', '9 2\n9 3\n'],
    [['f1', '', 'f2'], '{print}', '1\n2\n3\n'],
    [['1x=3'], '{print}', ''],
  ])('follows ARGV %j for %j', async (argv, program, expected) => {
    const host = new FakeHost({ f1: '1\n', f2: '2\n3\n', '1x=3': '' })
    const [out] = await execute(program, host, argv)
    expect(out).toBe(expected)
  })

  it('reads stdin after assignment-only operands', async () => {
    const [out] = await execute('{print x, $0, FILENAME}', new FakeHost({}, {}, 's\n'), ['x=1'])
    expect(out).toBe('1 s -\n')
  })

  it('ends the run at an operand that cannot be opened', async () => {
    const err = await fatal(
      execute('{getline; print}', new FakeHost({ f1: '1\n' }), ['f1', 'nope']),
    )
    expect(err.message).toBe('awk: cannot open "nope" (No such file or directory)')
  })

  it.each([
    ['BEGIN{while ((getline line < "g") > 0) print line}', 'a\nb\n'],
    ['BEGIN{while (getline line < "g" > 0) print line}', 'a\nb\n'],
    ['BEGIN{while (getline < "g" > 0) print $0}', 'a\nb\n'],
    ['BEGIN{r = (getline line < "nope"); print r}', '-1\n'],
    ['BEGIN{getline < "g"; print $0, NF, NR, FNR}', 'a 1 0 0\n'],
    ['BEGIN{getline a < "g"; close("g"); getline b < "g"; print a, b}', 'a a\n'],
    [
      'BEGIN{getline a < "g"; getline b < "g"; r = getline c < "g"; print a, b, r, "[" c "]"}',
      'a b 0 []\n',
    ],
    ['BEGIN{getline a < "g"; print close("g"), close("g"), close("x")}', '0 -1 -1\n'],
    ['BEGIN{r = getline x < "/" "g"; print r, "[" x "]"}', '-1g []\n'],
    ['BEGIN{RS=""; while ((getline l < "p")>0) print "[" l "]"}', '[a\nb]\n[c]\n'],
    ['BEGIN{RS="[0-9]"; while ((getline l < "r")>0) print l}', 'a\nb\nc\n'],
    ['BEGIN{FS=":"; getline < "c"; print $2, NF}', 'y 3\n'],
    ['BEGIN{r = getline v < "nope"; print r, length(v), (v == 0), (v == "")}', '-1 0 1 1\n'],
    ['BEGIN{x = "A"; getline x < "nope"; print x}', 'A\n'],
    ['BEGIN{getline v < "n"; print (v < 9)}', '0\n'],
    ['BEGIN{f="g"; print getline x < f + 1; print x}', '2\na\n'],
    ['BEGIN{n=1; f[1]="g"; getline x < f[n++]; print x, n}', 'a 2\n'],
    ['BEGIN{getline a["k"] < "g"; print a["k"]}', 'a\n'],
    ['BEGIN{ x = getline y < "g" == 1; print x, y }', '1 a\n'],
    ['BEGIN{ print getline < "g" < "g" }', '1\n'],
    ['function f(  l){ getline l < "g"; return l } BEGIN{print f()}', 'a\n'],
    ['BEGIN{print "x" > "o"; close("o"); getline l < "o"; print "l=" l}', 'l=x\n'],
    ['BEGIN{print "x" > "o"; getline l < "o"; print "l=" l}', 'l=\n'],
  ])('reads a file with %j', async (program, expected) => {
    const [out] = await execute(program, new FakeHost(GETLINE_FILES))
    expect(out).toBe(expected)
  })

  it('shares stdin between getline < "-" and the main input', async () => {
    const [out] = await execute(
      'NR==1{r = getline a < "-"; print "a=" a, r} {print}',
      new FakeHost({}, {}, 'p\nq\n'),
    )
    expect(out).toBe('a= 0\np\nq\n')
  })

  it.each([
    ['BEGIN{"echo hi" | getline x; print x}', 'hi\n'],
    ['BEGIN{while ("echo hi" | getline > 0) print "l", $0, NR, NF}', 'l hi 0 1\n'],
    [
      'BEGIN{"echo hi" | getline a; r = ("echo hi" | getline b); print a, r, "[" b "]", close("echo hi"), close("echo hi")}',
      'hi 0 [] 0 -1\n',
    ],
    ['BEGIN{"echo hi" | getline a; close("echo hi"); "echo hi" | getline b; print a b}', 'hihi\n'],
    ['BEGIN{"fail" | getline; print close("fail")}', '2\n'],
    ['BEGIN{x = 1 + "echo hi" | getline; print x, $0}', '2 hi\n'],
    ['BEGIN{x = "a" "echo hi" | getline; print x}', 'a1\n'],
    ['BEGIN{x = "echo hi" | getline + 1; print x}', '2\n'],
    ['BEGIN{x = -"echo hi" | getline; print x}', '-1\n'],
    ['BEGIN{x = "echo hi" | getline a "b"; print x, a}', '1b hi\n'],
    ['BEGIN{"echo hi" | getline $2; print $0; print NF}', ' hi\n2\n'],
  ])('reads a command with %j', async (program, expected) => {
    const host = new FakeHost({}, { 'echo hi': echo('hi\n'), fail: echo('', 2) })
    const [out] = await execute(program, host)
    expect(out).toBe(expected)
  })

  it('hands a command awk stdin when it runs', async () => {
    const host = new FakeHost({}, { cat })
    await execute('BEGIN{"cat" | getline x; system("cat")}', host)
    expect(host.runs).toEqual([
      ['cat', null],
      ['cat', null],
    ])
  })

  it.each([
    ['BEGIN{print "b" | "sort"; print "a" | "sort"; print "x"}', '[b\na\n]\nx\n'],
    ['BEGIN{print "0"; print "1" | "cat"; close("cat"); print "2"}', '0\n1\n2\n'],
    ['BEGIN{print "1" | "cat"; print "0"; close("cat"); print "2"}', '1\n0\n2\n'],
    ['BEGIN{print "1" | "cat"; print "0"; system("")}', '0\n1\n'],
    ['BEGIN{print "1" | "cat"; print "0"; fflush()}', '0\n1\n'],
    ['BEGIN{print "1" | "cat"; print "0"; "echo hi" | getline}', '0\n1\n'],
    ['BEGIN{print "1" | "cat"; print "0"; exit}', '1\n0\n'],
    ['BEGIN{print "c" | "cat"; print "s" | "sort"}', '[s\n]\nc\n'],
    ['BEGIN{print "x" | "cat"; r = close("cat"); print r, close("cat")}', 'x\n0 -1\n'],
    ['BEGIN{printf "%s", "z" | "cat"; close("cat"); print ""}', 'z\n'],
    ['BEGIN{print "to" | "cat"; system("echo hi"); print "end"}', 'hi\nto\nend\n'],
    ['BEGIN{print "a"; r = system("fail"); print "c", r}', 'a\nc 2\n'],
  ])('orders output pipes and system like mawk in %j', async (program, expected) => {
    const host = new FakeHost(
      {},
      {
        cat,
        sort: (stdin) => ({
          stdout: ENC.encode(`[${DEC.decode(stdin ?? new Uint8Array(0))}]\n`),
          stderr: new Uint8Array(0),
          status: 0,
        }),
        'echo hi': echo('hi\n'),
        fail: echo('', 2, 'oops\n'),
        '': echo(''),
      },
    )
    const [out] = await execute(program, host)
    expect(out).toBe(expected)
  })

  it('joins command stderr to awk stderr', async () => {
    const host = new FakeHost({}, { fail: echo('', 2, 'oops\n') })
    expect(await execute('BEGIN{system("fail"); print "o"}', host)).toEqual(['o\n', 'oops\n'])
  })

  it('lets a command see files written before it runs', async () => {
    const host = new FakeHost({}, { check: echo('') })
    const interp = new Interpreter(parse('BEGIN{printf "x" > "f"; system("check")}'), host)
    await interp.runBegin()
    expect(host.files.get('f')).toBe('x')
  })

  it('empties an output file when opened and fills it on flush', async () => {
    const host = new FakeHost({ f: 'old' })
    const interp = new Interpreter(parse('BEGIN{print "a" > "f"; print "b" > "f"}'), host)
    await interp.runBegin()
    expect(host.files.get('f')).toBe('')
    await interp.drain()
    expect(host.files.get('f')).toBe('a\nb\n')
  })

  it('answers fflush per stream', async () => {
    const [out] = await execute(
      'BEGIN{printf "x" > "q"; print fflush("q"), fflush("nope"), fflush(), fflush("")}',
      new FakeHost(),
    )
    expect(out).toBe('0 -1 0 0\n')
  })

  it('ends the run on an output failure, keeping earlier output', async () => {
    const interp = new Interpreter(parse('BEGIN{print "a"; print "b" > "/ro/x"}'), new FakeHost())
    const err = await fatal(interp.runBegin())
    const [out, stderr] = await interp.salvage(err)
    expect([DEC.decode(out), DEC.decode(stderr)]).toEqual([
      'a\n',
      'awk: cannot open "/ro/x" for output (Read-only file system)\n',
    ])
  })

  it.each([
    ['BEGIN{print 1/0}', 'awk: division by zero'],
    ['BEGIN{print 5%0}', 'awk: division by zero in %'],
    ['BEGIN{x=1; x/=0}', 'awk: division by zero in /='],
    ['BEGIN{x=1; x%=0}', 'awk: division by zero in %='],
    ['BEGIN{print $(-1)}', 'awk: trying to access field -1'],
    ['BEGIN{f(1)}', 'awk: calling undefined function f'],
    ['BEGIN{next}', 'awk: next used in a BEGIN action'],
    ['BEGIN{substr("a")}', 'awk: not enough arguments to substr'],
    ['function f(n){return f(n+1)} BEGIN{f(1)}', 'awk: function f nested deeper than 100 calls'],
  ])('fails %j with %j', async (program, message) => {
    let caught: Error | null = null
    try {
      await run(program)
    } catch (err) {
      if (!(err instanceof AwkRuntimeError)) throw err
      caught = err
    }
    expect(caught?.message).toBe(message)
  })
})

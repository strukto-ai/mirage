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
import { AwkRuntimeError } from './errors.ts'
import { ExitProgram, Interpreter } from './interp.ts'
import { parse } from './parser.ts'
import { text } from './value.ts'

const DATA = ['alice 30 eng', 'bob 25 ops', 'carol 41 eng', 'dave 19 ops']

interface RunOpts {
  lines?: string[]
  fs?: string
  assignments?: Record<string, string>
}

function run(program: string, o: RunOpts = {}): string {
  const interp = new Interpreter(parse(program), o.assignments ?? {})
  if (o.fs !== undefined) interp.setVar('FS', text(o.fs))
  interp.runBegin()
  for (const line of o.lines ?? []) interp.runRecord(line)
  interp.runEnd()
  return interp.drain()
}

describe('awk interpreter', () => {
  it('builds an indent in a for loop', () => {
    const program = '{indent="";for(i=1;i<NF;i++)indent=indent"    ";print indent $NF}'
    const lines = ['School/Courses_Materials/notes.md', 'top.txt']
    expect(run(program, { lines, fs: '/' })).toBe('        notes.md\ntop.txt\n')
  })

  it('splits fields at newlines too in paragraph mode', () => {
    const lines = ['a:b\nc']
    expect(run('{print NF}', { lines, fs: ':', assignments: { RS: '' } })).toBe('3\n')
    expect(run('{print NF}', { lines, fs: ':' })).toBe('2\n')
    expect(run('{RS=""; print NF}', { lines: ['a:b\nc', 'd:e\nf'], fs: ':' })).toBe('2\n3\n')
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
  ])('runs %j over records', (program, expected) => {
    expect(run(program, { lines: DATA })).toBe(expected)
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
    ['BEGIN{print length("héllo"), toupper("abc"), index("hello","ll")}', '5 ABC 3\n'],
    ['BEGIN{print match("foobar",/o+/), RSTART, RLENGTH}', '2 2 2\n'],
    ['BEGIN{srand(1); a=rand(); srand(1); print (a==rand()), (a<1)}', '1 1\n'],
    ['BEGIN{a[10]; a[9]; a["x"]; for(k in a)printf "%s ", k}', '10 9 x '],
  ])('runs %j', (program, expected) => {
    expect(run(program)).toBe(expected)
  })

  it('rebuilds the record on a field assignment', () => {
    expect(run('{$2="X"; print; print NF}', { lines: ['a b c'] })).toBe('a X c\n3\n')
    expect(run('{NF=2; print}', { lines: ['a b c'] })).toBe('a b\n')
    expect(run('{$5="e"; print; print NF}', { lines: ['a b'] })).toBe('a b   e\n5\n')
    expect(run('BEGIN{OFS="-"} {$1=$1; print}', { lines: ['a b c'] })).toBe('a-b-c\n')
  })

  it('applies an FS assigned in an action from the next record', () => {
    expect(run('{FS=":"; print $1}', { lines: ['a:b c', 'd:e f'] })).toBe('a:b\nd\n')
  })

  it('compares strnum fields numerically', () => {
    expect(run('{print ($1==10), ($1=="10"), ($3==0)}', { lines: ['10.0 x'] })).toBe('1 0 0\n')
  })

  it('reads a command-line assignment as a strnum', () => {
    expect(run('BEGIN{print n+1, (n==5)}', { assignments: { n: '5' } })).toBe('6 1\n')
  })

  it('carries the exit code and still runs END', () => {
    const interp = new Interpreter(parse('NR==2{exit 3} {print} END{print "end"}'))
    interp.runRecord('a')
    let code = -1
    try {
      interp.runRecord('b')
    } catch (err) {
      if (!(err instanceof ExitProgram)) throw err
      code = err.code
    }
    expect(code).toBe(3)
    interp.runEnd()
    expect(interp.drain()).toBe('a\nend\n')
  })

  it('flags the driver on nextfile', () => {
    const interp = new Interpreter(parse('{print; nextfile}'))
    interp.startFile('a.txt')
    interp.runRecord('one')
    expect(interp.skipFile).toBe(true)
    interp.startFile('b.txt')
    expect(interp.skipFile).toBe(false)
  })

  it('restarts FNR and sets FILENAME per file', () => {
    const interp = new Interpreter(parse('{print FILENAME, NR, FNR}'))
    interp.startFile('a.txt')
    interp.runRecord('x')
    interp.startFile('b.txt')
    interp.runRecord('y')
    expect(interp.drain()).toBe('a.txt 1 1\nb.txt 2 1\n')
  })

  it('keeps /dev/stderr apart', () => {
    const interp = new Interpreter(parse('{print "w" > "/dev/stderr"; print}'))
    interp.runRecord('a')
    expect(interp.drain()).toBe('a\n')
    expect(interp.drainErr()).toBe('w\n')
  })

  it.each([
    ['BEGIN{print 1/0}', 'awk: division by zero'],
    ['BEGIN{print 5%0}', 'awk: division by zero in %'],
    ['BEGIN{x=1; x/=0}', 'awk: division by zero in /='],
    ['BEGIN{x=1; x%=0}', 'awk: division by zero in %='],
    ['BEGIN{print $(-1)}', 'awk: trying to access field -1'],
    ['BEGIN{getline x}', 'awk: getline is not supported in mirage'],
    ['BEGIN{"date" | getline x}', 'awk: getline is not supported in mirage'],
    ['BEGIN{print 1 | "sort"}', 'awk: output pipes are not supported in mirage'],
    ['BEGIN{system("ls")}', 'awk: system() is not supported in mirage'],
    ['BEGIN{f(1)}', 'awk: calling undefined function f'],
    ['BEGIN{next}', 'awk: next used in a BEGIN action'],
    ['BEGIN{substr("a")}', 'awk: not enough arguments to substr'],
    ['function f(n){return f(n+1)} BEGIN{f(1)}', 'awk: function f nested deeper than 100 calls'],
  ])('fails %j with %j', (program, message) => {
    let caught: Error | null = null
    try {
      run(program)
    } catch (err) {
      if (!(err instanceof AwkRuntimeError)) throw err
      caught = err
    }
    expect(caught?.message).toBe(message)
  })
})

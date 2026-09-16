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
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_BC } from './bc.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runBc(
  stdin: string,
  flags: Record<string, string | boolean | number | string[]> = {},
  env?: Record<string, string>,
): Promise<{ out: string; err: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_BC[0]
  if (cmd === undefined) throw new Error('bc not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin: ENC.encode(stdin),
    flags,
    filetypeFns: null,
    cwd: '/',
    ...(env === undefined ? {} : { env }),
  })
  if (result === null) return { out: '', err: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), err: await ioResult.stderrStr(), exitCode: ioResult.exitCode }
}

// 2^300 is 91 digits: GNU prints 68 of them, a backslash, then the
// other 23.
const POWER_300 =
  '20370359763344860862684456884093781610514683936659362506361404493543' +
  '\\\n' +
  '81299763336706183397376\n'
const UNFOLDED_300 = POWER_300.replace('\\\n', '')

describe('bc', () => {
  it('simple addition', async () => {
    expect(await runBc('2+3\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('multiple lines', async () => {
    expect(await runBc('1+1\n2*3\n')).toEqual({ out: '2\n6\n', err: '', exitCode: 0 })
  })

  it('operator precedence', async () => {
    expect(await runBc('2+3*4\n')).toEqual({ out: '14\n', err: '', exitCode: 0 })
  })

  it('parentheses', async () => {
    expect(await runBc('(2+3)*4\n')).toEqual({ out: '20\n', err: '', exitCode: 0 })
  })

  it('exponentiation with ^', async () => {
    expect(await runBc('2^10\n')).toEqual({ out: '1024\n', err: '', exitCode: 0 })
  })

  // Repeated squaring on a base and a result float64 represents exactly
  // is exact, so these are GNU's answers byte for byte. 10^22 is the
  // largest power of ten float64 holds exactly; 10^23 is not one.
  it('^ is exact where float64 is exact', async () => {
    const want: [string, string][] = [
      ['2^31', '2147483648'],
      ['2^62', '4611686018427387904'],
      ['10^22', '10000000000000000000000'],
      ['3^5', '243'],
    ]
    for (const [line, out] of want) {
      expect(await runBc(line + '\n')).toEqual({ out: out + '\n', err: '', exitCode: 0 })
    }
  })

  // The divergence the in-tree power exists to close: `**` through V8
  // and `pow` through glibc are one ulp apart here, and the renderer
  // prints the shortest digits that read back as the double, so the ulp
  // reached stdout as 24257295885134.4530 against .4570. Both hosts now
  // multiply in one order. GNU, being exact decimal, answers
  // 24257295885134.4544 and 821783259531709.90, which no double carries.
  it('^ of a fractional base agrees between the hosts', async () => {
    expect(await runBc('7.8041^15\n')).toEqual({
      out: '24257295885134.4650\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('9.87^15\n')).toEqual({
      out: '821783259531708.90\n',
      err: '',
      exitCode: 0,
    })
  })

  // Measured: a non-negative exponent gives the result
  // `min(scale(base)*exponent, max(scale, scale(base)))` fractional
  // digits, so the global scale does not truncate a power down to it,
  // while a negative exponent adopts the global scale outright.
  it('^ scale rules are GNUs', async () => {
    const want: [string, string][] = [
      ['scale=0; 1.1^3', '1.3'],
      ['scale=0; 2.5^2', '6.2'],
      ['scale=0; (-1.5)^3', '-3.3'],
      ['scale=7; 1.05^3', '1.157625'],
      ['scale=0; 0.1^3', '0'],
      ['scale=3; 0.1^3', '.001'],
      ['2^-3', '0'],
      ['scale=3; 2^-3', '.125'],
      ['scale=3; 1.5^-2', '.444'],
      ['2^0', '1'],
      ['0^0', '1'],
    ]
    for (const [line, out] of want) {
      expect(await runBc(line + '\n')).toEqual({ out: out + '\n', err: '', exitCode: 0 })
    }
  })

  // GNU truncates the exponent toward zero and warns whenever the value
  // it truncated carried a scale at all -- `2^1.0` warns although its
  // value is whole -- so the test is the operand's scale, not its
  // fraction. `3/2` is 1 at scale 0, an exponent with no scale.
  it('a non-integer exponent is truncated with a warning', async () => {
    expect(await runBc('2^1.5\n')).toEqual({
      out: '2\n',
      err: 'Runtime warning (func=(main), adr=3): non-zero scale in exponent\n',
      exitCode: 0,
    })
    expect(await runBc('2^1.0\n')).toEqual({
      out: '2\n',
      err: 'Runtime warning (func=(main), adr=3): non-zero scale in exponent\n',
      exitCode: 0,
    })
    expect(await runBc('2^(3/2)\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('2^2.5^2\n')).toEqual({
      out: '64\n',
      err: 'Runtime warning (func=(main), adr=3): non-zero scale in exponent\n',
      exitCode: 0,
    })
  })

  // GNU words this one in lowercase where `1/0` is capitalised: the two
  // are raised from different places in its source. The exponent
  // warning is reported before the refusal.
  it('zero to a negative power is a lowercase divide by zero', async () => {
    expect(await runBc('0^-1\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): divide by zero\n',
      exitCode: 0,
    })
    expect(await runBc('0^-1.5\n')).toEqual({
      out: '',
      err:
        'Runtime warning (func=(main), adr=3): non-zero scale in exponent\n' +
        'Runtime error (func=(main), adr=3): divide by zero\n',
      exitCode: 0,
    })
  })

  // A double is a dyadic rational, so its expansion is finite and gets
  // truncated exactly rather than rounded by a formatter. 2^-101 is the
  // case that proves it: its expansion is exactly 101 digits long and
  // the last one is a 5, so `toFixed`'s half-away-from-zero and
  // python's half-to-even disagree, which is how the two hosts used to.
  // These are GNU's own 100 digits (GNU folds the line at 70 characters
  // with a trailing backslash, which neither host does).
  it('the hundredth digit is truncated, not rounded', async () => {
    // GNU's own 100 digits, measured, with the backslash it folds the
    // line at after 68 characters of value.
    const head = '3944304526105059027058642826413931148'
    const tail = '366032175545115023851394653320312'
    expect(await runBc('scale=100; 2^-101\n')).toEqual({
      out: '.' + '0'.repeat(30) + head + '\\\n' + tail + '\n',
      err: '',
      exitCode: 0,
    })
  })

  // GNU's `bc_sqrt` short-circuits an argument of exactly one to its own
  // canonical one, which carries no scale. The rule is narrower than "a
  // perfect square" and narrower than "an exact result": every other
  // exact root is padded to the result scale, and so is the math
  // library's own one. Every expectation measured on bc 1.07.1.
  it('sqrt of one is a bare one at every scale', async () => {
    const want: [string, string][] = [
      ['scale=100; sqrt(1)', '1'],
      ['scale=5; sqrt(1)', '1'],
      ['scale=0; sqrt(1)', '1'],
      // It compares the value, not the digits written.
      ['scale=5; sqrt(1.00)', '1'],
      ['scale=5; sqrt(3/3)', '1'],
      ['scale=5; sqrt(0.5*2)', '1'],
      // Every other exact root still pads, which is the narrowness.
      ['scale=5; sqrt(4)', '2.00000'],
      ['scale=5; sqrt(9)', '3.00000'],
      ['scale=5; sqrt(0.25)', '.50000'],
      ['scale=5; sqrt(1.44)', '1.20000'],
      // A hair off one is not one.
      ['scale=5; sqrt(1.0000001)', '1.0000000'],
    ]
    for (const [line, out] of want) {
      expect(await runBc(line + '\n')).toEqual({ out: out + '\n', err: '', exitCode: 0 })
    }
    // A one the math library produced still pads, so it is `sqrt`'s
    // rule and not a rule about the value one.
    expect((await runBc('scale=5; c(0)\n', { args_l: true })).out).toBe('1.00000\n')
  })

  // The short-circuit gives the result a real scale of 0, which is
  // observable through `scale()`, through `length()`, and through a
  // division that adopts the global scale instead. A bare `length` or
  // `scale` is untouched by it.
  it('sqrt of one carries scale zero, not just a short rendering', async () => {
    const want: [string, string][] = [
      ['scale=5; scale(sqrt(1))', '0'],
      ['scale=5; length(sqrt(1))', '1'],
      ['scale=5; sqrt(1)/1', '1.00000'],
      ['scale=5; scale(1.00)', '2'],
      ['scale=5; length(1.230)', '4'],
      ['scale=5; scale(sqrt(4))', '5'],
    ]
    for (const [line, out] of want) {
      expect((await runBc(line + '\n')).out).toBe(out + '\n')
    }
  })

  // GNU reports a negative square root rather than answering a NaN,
  // keeps going, and still exits 0. Only the bytecode address differs
  // from GNU's, which is the file-wide `RUNTIME_ERROR_ADDR` divergence
  // (GNU says 4 here).
  it('sqrt of a negative number is refused', async () => {
    expect(await runBc('sqrt(-1)\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Square root of a negative number\n',
      exitCode: 0,
    })
    expect((await runBc('1+sqrt(-1)\n')).out).toBe('')
    expect((await runBc('sqrt(-1)\n2+2\n')).out).toBe('4\n')
  })

  // GNU writes a printed value a character at a time and breaks with a
  // backslash and a newline when the column reaches `line_size`, so a
  // folded line carries `line_size - 2` characters of the value. Every
  // expectation below is real bc 1.07.1's output byte for byte, and
  // every value is one float64 carries exactly, so none of it is
  // confounded by the precision gap.
  it('a long value folds at sixty-eight characters', async () => {
    expect(await runBc('2^300\n')).toEqual({ out: POWER_300, err: '', exitCode: 0 })
    expect(await runBc('obase=2; 2^100\n')).toEqual({
      out: '1' + '0'.repeat(67) + '\\\n' + '0'.repeat(33) + '\n',
      err: '',
      exitCode: 0,
    })
  })

  // 2^-67 renders as 68 characters and does not fold; 2^-68 renders as
  // 69 and folds, leaving one character on the second line. Both are
  // powers of two, so their expansions are exact at these scales.
  it('the fold boundary is sixty-eight characters of value', async () => {
    expect((await runBc('scale=67; 2^-67\n')).out).toBe(
      '.0000000000000000000067762635780344027125465800054371356964111328125\n',
    )
    expect((await runBc('scale=68; 2^-68\n')).out).toBe(
      '.0000000000000000000033881317890172013562732900027185678482055664062\\\n5\n',
    )
  })

  // A short value printed after a folded one starts at the left margin
  // again, because GNU's column resets on the newline it just wrote.
  it('the fold column is counted per value', async () => {
    expect((await runBc('2^300; 1+1\n')).out).toBe(POWER_300 + '2\n')
  })

  // 118 characters on one line: the fold is the printed value's, not
  // the output stream's.
  it('a long diagnostic does not fold', async () => {
    const name = 'f'.repeat(60)
    expect(await runBc(name + '(1)\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Function ' + name + ' not defined.\n',
      exitCode: 0,
    })
  })

  // `BC_LINE_LENGTH=0` turns folding off outright, and any other width
  // puts `width - 2` characters on a line. Measured against GNU.
  it('BC_LINE_LENGTH sets the fold width', async () => {
    expect((await runBc('2^300\n', {}, { BC_LINE_LENGTH: '0' })).out).toBe(UNFOLDED_300)
    const digits = UNFOLDED_300.slice(0, -1)
    const chunks: string[] = []
    for (let at = 0; at < digits.length; at += 8) chunks.push(digits.slice(at, at + 8))
    expect((await runBc('2^300\n', {}, { BC_LINE_LENGTH: '10' })).out).toBe(
      chunks.join('\\\n') + '\n',
    )
  })

  // GNU reads it with `atoi`, so trailing garbage is ignored and a
  // value with no digits at all reads as 0, which turns folding off. A
  // width below 3 that is not 0 falls back to the default, and the
  // value is truncated to a C `int`, which is why 4294967296 reads as 0
  // and 2147483648 does not. Every row measured against GNU.
  it('BC_LINE_LENGTH is read the way C reads it', async () => {
    const want: [string, string][] = [
      ['abc', UNFOLDED_300],
      ['0x46', UNFOLDED_300],
      ['', UNFOLDED_300],
      ['4294967296', UNFOLDED_300],
      ['70', POWER_300],
      ['+70', POWER_300],
      ['-1', POWER_300],
      ['1e3', POWER_300],
      ['2', POWER_300],
      ['2147483648', POWER_300],
      ['9223372036854775808', POWER_300],
      ['99999999999999999999', POWER_300],
    ]
    for (const [value, out] of want) {
      expect((await runBc('2^300\n', {}, { BC_LINE_LENGTH: value })).out).toBe(out)
    }
  })

  it('right-associative ^', async () => {
    // 2^3^2 = 2^9 = 512
    expect(await runBc('2^3^2\n')).toEqual({ out: '512\n', err: '', exitCode: 0 })
  })

  it('floats keep the product scale', async () => {
    // `*` scales to min(1+0, max(scale, 1, 0)) = 1, so GNU prints 3.0.
    expect(await runBc('1.5*2\n')).toEqual({ out: '3.0\n', err: '', exitCode: 0 })
  })

  it('negative unary', async () => {
    expect(await runBc('-5+10\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('modulus', async () => {
    expect(await runBc('10%3\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
  })

  it('default scale is 0', async () => {
    expect(await runBc('scale\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('division truncates at the default scale', async () => {
    expect(await runBc('7/2\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
  })

  it('negative division truncates toward zero', async () => {
    expect(await runBc('-7/2\n')).toEqual({ out: '-3\n', err: '', exitCode: 0 })
  })

  it('remainder takes the dividend sign', async () => {
    expect(await runBc('-7%2\n')).toEqual({ out: '-1\n', err: '', exitCode: 0 })
  })

  it('scale is assignable and pads the quotient', async () => {
    expect(await runBc('scale=2; 7/2\n')).toEqual({ out: '3.50\n', err: '', exitCode: 0 })
  })

  it('addition keeps the wider operand scale and drops the leading zero', async () => {
    expect(await runBc('0.1+0.2\n')).toEqual({ out: '.3\n', err: '', exitCode: 0 })
  })

  it('a product that lands on a half truncates toward zero', async () => {
    // 2.25 at scale 1: truncation and half-to-even agree here, which is
    // exactly why this row alone never caught the rounding bug.
    expect(await runBc('1.5*1.5\n')).toEqual({ out: '2.2\n', err: '', exitCode: 0 })
  })

  it('an exact power prints every digit', async () => {
    expect(await runBc('2^100\n')).toEqual({
      out: '1267650600228229401496703205376\n',
      err: '',
      exitCode: 0,
    })
  })

  it('tabs are blanks, not a hard error', async () => {
    expect(await runBc('2\t+\t3\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('sqrt is a builtin, available without -l', async () => {
    expect(await runBc('sqrt(16)\n')).toEqual({ out: '4\n', err: '', exitCode: 0 })
  })

  it('a math-library name without -l is an undefined function', async () => {
    expect(await runBc('s(0)\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Function s not defined.\n',
      exitCode: 0,
    })
  })

  it('an unknown function under -l is a runtime error', async () => {
    expect(await runBc('zz(1)\n', { args_l: true })).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Function zz not defined.\n',
      exitCode: 0,
    })
  })

  it('-l raises scale to 20', async () => {
    expect(await runBc('scale\n', { args_l: true })).toEqual({ out: '20\n', err: '', exitCode: 0 })
  })

  it('-l stops division truncating', async () => {
    expect(await runBc('7/2\n', { args_l: true })).toEqual({
      out: '3.50000000000000000000\n',
      err: '',
      exitCode: 0,
    })
  })

  // The six functions under -l, at the float64 values both hosts share.
  // GNU is arbitrary precision, so its last digits differ on the
  // irrationals; that gap is accepted and documented, and what is pinned
  // here is what the python twin answers: the shortest digits that read
  // back as the double, padded with zeros past float64's ~17 significant
  // digits.
  it('-l sqrt', async () => {
    expect(await runBc('sqrt(2)\n', { args_l: true })).toEqual({
      out: '1.41421356237309510000\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l sine of zero is a bare zero', async () => {
    expect(await runBc('s(0)\n', { args_l: true })).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('-l cosine of zero is padded', async () => {
    expect(await runBc('c(0)\n', { args_l: true })).toEqual({
      out: '1.00000000000000000000\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l arctangent of one', async () => {
    // From the in-tree series rather than a libm, so the last bit is
    // the series' -- one ulp either way, and the same ulp in both
    // hosts, which is the point. GNU: .78539816339744830961.
    expect(await runBc('a(1)\n', { args_l: true })).toEqual({
      out: '.78539816339744840000\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l log of one is a bare zero', async () => {
    expect(await runBc('l(1)\n', { args_l: true })).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('-l exponential of one', async () => {
    // GNU: 2.71828182845904523536.
    expect(await runBc('e(1)\n', { args_l: true })).toEqual({
      out: '2.71828182845904550000\n',
      err: '',
      exitCode: 0,
    })
  })

  // The divergence the in-tree series exist to close: `Math.cos(.1)`
  // and `math.cos(.1)` are one ulp apart, and the renderer prints the
  // shortest digits that read back as the double, so the ulp reached
  // stdout. Both hosts now compute the same double.
  it('-l cosine and log are computed from series, not from a libm', async () => {
    expect(await runBc('c(.1)\n', { args_l: true })).toEqual({
      out: '.99500416527802570000\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('l(3)\n', { args_l: true })).toEqual({
      out: '1.09861228866810980000\n',
      err: '',
      exitCode: 0,
    })
  })

  // Every one of these is GNU bc 1.07.1's own output byte for byte
  // (measured): float64 carries about 17 significant digits, so the gap
  // only opens past a scale of 15.
  it('-l matches GNU exactly up to scale fifteen', async () => {
    const want: [string, string][] = [
      ['scale=15; s(1)', '.841470984807896'],
      ['scale=15; c(.1)', '.995004165278025'],
      ['scale=15; l(3)', '1.098612288668109'],
      ['scale=15; a(1)', '.785398163397448'],
      ['scale=15; e(1)', '2.718281828459045'],
      ['scale=10; c(1)', '.5403023058'],
      ['scale=10; a(2)', '1.1071487177'],
      ['scale=10; l(10)', '2.3025850929'],
      ['scale=10; e(2)', '7.3890560989'],
    ]
    for (const [line, out] of want) {
      expect(await runBc(line + '\n', { args_l: true })).toEqual({
        out: out + '\n',
        err: '',
        exitCode: 0,
      })
    }
  })

  // `2^10000` leaves float64's range, and the reductions have to refuse
  // such an argument rather than iterate on it: the log's square-root
  // loop and the trigonometric quadrant reduction both run forever on an
  // infinity. GNU is arbitrary precision and has no infinity at all, so
  // there is nothing to match but the other host.
  // `2^10000-2^10000` is the NaN -- an infinity less itself. `sqrt(-1)`
  // used to be how to write one; GNU refuses that, so it is a runtime
  // error now.
  it('-l answers a non-finite argument', async () => {
    const want: [string, string][] = [
      ['l(2^10000)', 'Infinity'],
      ['s(2^10000)', 'NaN'],
      ['c(2^10000)', 'NaN'],
      ['e(2^10000)', 'Infinity'],
      ['e(0-2^10000)', '0'],
      ['a(2^10000)', '1.57079632679489660000'],
      ['l(2^10000-2^10000)', 'NaN'],
      ['s(2^10000-2^10000)', 'NaN'],
      ['c(2^10000-2^10000)', 'NaN'],
      ['a(2^10000-2^10000)', 'NaN'],
      ['e(2^10000-2^10000)', 'NaN'],
    ]
    for (const [line, out] of want) {
      expect(await runBc(line + '\n', { args_l: true })).toEqual({
        out: out + '\n',
        err: '',
        exitCode: 0,
      })
    }
  })

  // GNU's libmath.b `l(x)` answers `(1 - 10^scale)/1` for x <= 0 rather
  // than refusing, and float64 carries that exactly to a scale of 15.
  it('-l log of a non-positive argument answers from scale', async () => {
    expect(await runBc('scale=5; l(0)\n', { args_l: true })).toEqual({
      out: '-99999.00000\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale=5; l(-1)\n', { args_l: true })).toEqual({
      out: '-99999.00000\n',
      err: '',
      exitCode: 0,
    })
  })

  it('divide by zero is non-fatal and later statements still run', async () => {
    expect(await runBc('1/0\n2+2\n')).toEqual({
      out: '4\n',
      err: 'Runtime error (func=(main), adr=3): Divide by zero\n',
      exitCode: 0,
    })
  })

  it('modulo by zero has its own wording', async () => {
    expect(await runBc('1%0\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Modulo by zero\n',
      exitCode: 0,
    })
  })

  it('skips blank lines', async () => {
    expect(await runBc('1+1\n\n2+2\n')).toEqual({ out: '2\n4\n', err: '', exitCode: 0 })
  })

  // -- Section S: reducing to a scale TRUNCATES TOWARD ZERO -----------
  // Every row below distinguishes truncation from both rounding modes,
  // and none of them sits on a float64 boundary where the two would
  // agree by accident. `1.005` and `1.015` are deliberately absent:
  // they are not exactly representable, so they test nothing.

  it('a product truncates rather than rounding', async () => {
    // The decisive row: 1.5*2.5 is exactly 3.75 and the product's scale
    // is 1, so it has to be reduced. Rounding either way says 3.8.
    expect(await runBc('1.5*2.5\n')).toEqual({ out: '3.7\n', err: '', exitCode: 0 })
  })

  it('the rest of the product truncation table', async () => {
    // 0.7*0.7 is 0.48999999999999994 in float64 and 0.49 exactly in
    // GNU; truncation answers `.4` for both reasons, rounding `.5`.
    expect(await runBc('0.7*0.7\n')).toEqual({ out: '.4\n', err: '', exitCode: 0 })
    expect(await runBc('0.29*0.3\n')).toEqual({ out: '.08\n', err: '', exitCode: 0 })
  })

  it('truncation is toward zero, not floor', async () => {
    // A floor would answer -.5 and -3.8 here.
    expect(await runBc('-0.7*0.7\n')).toEqual({ out: '-.4\n', err: '', exitCode: 0 })
    expect(await runBc('-1.5*2.5\n')).toEqual({ out: '-3.7\n', err: '', exitCode: 0 })
    expect(await runBc('1.5*-2.5\n')).toEqual({ out: '-3.7\n', err: '', exitCode: 0 })
    expect(await runBc('0-1.5*2.5\n')).toEqual({ out: '-3.7\n', err: '', exitCode: 0 })
  })

  it('a quotient truncates rather than rounding', async () => {
    expect(await runBc('scale=1; 2/3\n')).toEqual({ out: '.6\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 7/8\n')).toEqual({ out: '.8\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; 9/10\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 1.99/1\n')).toEqual({ out: '1.9\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 1.95/1\n')).toEqual({ out: '1.9\n', err: '', exitCode: 0 })
  })

  it('a negative quotient truncates toward zero', async () => {
    expect(await runBc('scale=1; -7/8\n')).toEqual({ out: '-.8\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; -2/3\n')).toEqual({ out: '-.6\n', err: '', exitCode: 0 })
    // An exact zero prints as a bare `0`, with no minus sign.
    expect(await runBc('scale=0; -9/10\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('dividing by one at scale 0 rules out both rounding modes', async () => {
    // The cleanest tie set of all: `/1` reduces a literal without
    // changing its value. 0,1,2 rules out half-to-even (0,2,2) and
    // half-up (1,2,3) at once.
    expect(await runBc('scale=0; 0.5/1\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; 1.5/1\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; 2.5/1\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; -1.5/1\n')).toEqual({ out: '-1\n', err: '', exitCode: 0 })
  })

  it('powers and function results truncate too', async () => {
    expect(await runBc('scale=1; 1.05^3\n')).toEqual({ out: '1.15\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 1.5^2\n')).toEqual({ out: '2.2\n', err: '', exitCode: 0 })
    expect(await runBc('scale=2; sqrt(0.5)\n')).toEqual({ out: '.70\n', err: '', exitCode: 0 })
    expect(await runBc('scale=5; l(2)\n', { args_l: true })).toEqual({
      out: '.69314\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale=5; a(1)\n', { args_l: true })).toEqual({
      out: '.78539\n',
      err: '',
      exitCode: 0,
    })
  })

  it('a literal is never reduced, and neither is a sum', async () => {
    expect(await runBc('scale=0; 1.9\n')).toEqual({ out: '1.9\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; 1.5\n')).toEqual({ out: '1.5\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; -1.5\n')).toEqual({ out: '-1.5\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 1.99\n')).toEqual({ out: '1.99\n', err: '', exitCode: 0 })
    expect(await runBc('scale=0; 1.9+0\n')).toEqual({ out: '1.9\n', err: '', exitCode: 0 })
    expect(await runBc('scale=1; 1.25+1.25\n')).toEqual({ out: '2.50\n', err: '', exitCode: 0 })
  })

  it('the value is reduced before it is formatted', async () => {
    // Formatting 0.4999999999 at one place would round it up to `.5`.
    expect(await runBc('scale=1; 0.4999999999/1\n')).toEqual({ out: '.4\n', err: '', exitCode: 0 })
  })

  // -- Section P: the symbol table ------------------------------------

  it('an undefined variable reads as zero', async () => {
    expect(await runBc('x\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('x+1\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('q*3+1\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
  })

  it('variables survive between statements', async () => {
    expect(await runBc('x=5; x*2\n')).toEqual({ out: '10\n', err: '', exitCode: 0 })
    expect(await runBc('abc=7\nabc+1\n')).toEqual({ out: '8\n', err: '', exitCode: 0 })
    expect(await runBc('x=5\ny\nx+y\n')).toEqual({ out: '0\n5\n', err: '', exitCode: 0 })
  })

  it('a name is lowercase with digits and underscores', async () => {
    expect(await runBc('x1=3; x1\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('x_=1; x_\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('a_b=4; a_b\n')).toEqual({ out: '4\n', err: '', exitCode: 0 })
  })

  it('an assignment prints nothing but a parenthesised one does', async () => {
    expect(await runBc('x=5\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('(x=5)\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
    expect(await runBc('x=y=3; x; y\n')).toEqual({ out: '3\n3\n', err: '', exitCode: 0 })
  })

  it('compound assignments', async () => {
    expect(await runBc('x=1; x+=2; x\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('x=1; x+=2\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('x=10; x-=3; x\n')).toEqual({ out: '7\n', err: '', exitCode: 0 })
    expect(await runBc('x=10; x*=3; x\n')).toEqual({ out: '30\n', err: '', exitCode: 0 })
    expect(await runBc('x=10; x/=3; x\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('x=10; x%=3; x\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('x=10; x^=2; x\n')).toEqual({ out: '100\n', err: '', exitCode: 0 })
  })

  it('an increment prints where an assignment does not', async () => {
    expect(await runBc('x=5; x++; x\n')).toEqual({ out: '5\n6\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; ++x; x\n')).toEqual({ out: '6\n6\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; x--; x\n')).toEqual({ out: '5\n4\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; --x; x\n')).toEqual({ out: '4\n4\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; y=x++; y; x\n')).toEqual({ out: '5\n6\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; y=++x; y; x\n')).toEqual({ out: '6\n6\n', err: '', exitCode: 0 })
  })

  it('=- is an assignment then a negation, not -=', async () => {
    expect(await runBc('x=1; x =- 2; x\n')).toEqual({ out: '-2\n', err: '', exitCode: 0 })
  })

  it('a variable carries its own scale', async () => {
    expect(await runBc('scale=2; x=1/3; x\n')).toEqual({ out: '.33\n', err: '', exitCode: 0 })
    expect(await runBc('x=1/3; scale=5; x\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    // The stored value is already truncated, so raising scale cannot
    // recover digits, and lowering it does not re-truncate.
    expect(await runBc('scale=2; x=1/3; scale=5; x\n')).toEqual({
      out: '.33\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale=2; x=1/3; scale=5; x+0\n')).toEqual({
      out: '.33\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale=5; x=1/3; scale=1; x\n')).toEqual({
      out: '.33333\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale=2; x=1/3; y=x*3; y\n')).toEqual({
      out: '.99\n',
      err: '',
      exitCode: 0,
    })
  })

  it('an assignment does not reduce a literal', async () => {
    expect(await runBc('scale=2; x=1.23456; x\n')).toEqual({
      out: '1.23456\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('x=1.23456; scale\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('uppercase letters are digits, not names', async () => {
    // A single digit keeps its own value whatever ibase is; every digit
    // of a multi-digit literal is clamped to ibase-1, so `FF` is 99.
    expect(await runBc('A\n')).toEqual({ out: '10\n', err: '', exitCode: 0 })
    expect(await runBc('X\n')).toEqual({ out: '33\n', err: '', exitCode: 0 })
    expect(await runBc('Z\n')).toEqual({ out: '35\n', err: '', exitCode: 0 })
    expect(await runBc('FF\n')).toEqual({ out: '99\n', err: '', exitCode: 0 })
  })

  it('assigning to an uppercase letter is a syntax error', async () => {
    expect(await runBc('X=5\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('a mixed-case name is a syntax error', async () => {
    expect(await runBc('aBc=1\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('a leading underscore is an illegal character', async () => {
    expect(await runBc('_x=1\n')).toEqual({
      out: '',
      err: '(standard_in) 1: illegal character: _\n',
      exitCode: 0,
    })
  })

  it('reserved words are not names', async () => {
    for (const word of [
      'length',
      'if',
      'print',
      'sqrt',
      'define',
      'while',
      'for',
      'auto',
      'read',
      'halt',
    ]) {
      expect(await runBc(`${word}=1\n`)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
  })

  it('variable and function namespaces are separate', async () => {
    // `s` the variable does not shadow `s` the sine under -l.
    expect(await runBc('s=5; s; s(0)\n', { args_l: true })).toEqual({
      out: '5\n0\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('s=5; s\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('an unknown function is a runtime error', async () => {
    expect(await runBc('foo(1)\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Function foo not defined.\n',
      exitCode: 0,
    })
  })

  // -- Section P5: the registers --------------------------------------

  it('register defaults', async () => {
    expect(await runBc('ibase; obase; scale\n')).toEqual({
      out: '10\n10\n0\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('last\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('last tracks each printed statement', async () => {
    expect(await runBc('1+1; last\n')).toEqual({ out: '2\n2\n', err: '', exitCode: 0 })
    expect(await runBc('1+1; last+1; last\n')).toEqual({ out: '2\n3\n3\n', err: '', exitCode: 0 })
  })

  it('a bare dot is an alias for last', async () => {
    expect(await runBc('1+1; .\n')).toEqual({ out: '2\n2\n', err: '', exitCode: 0 })
    expect(await runBc('x=5; .=9; last\n')).toEqual({ out: '9\n', err: '', exitCode: 0 })
  })

  it('ibase reads literals in the input base', async () => {
    expect(await runBc('ibase=16; FF\n')).toEqual({ out: '255\n', err: '', exitCode: 0 })
    expect(await runBc('ibase=16; ibase\n')).toEqual({ out: '16\n', err: '', exitCode: 0 })
    expect(await runBc('ibase=20; J\n')).toEqual({ out: '19\n', err: '', exitCode: 0 })
  })

  it('obase prints results in the output base', async () => {
    expect(await runBc('obase=16; 255\n')).toEqual({ out: 'FF\n', err: '', exitCode: 0 })
    expect(await runBc('obase=2; 10\n')).toEqual({ out: '1010\n', err: '', exitCode: 0 })
    // The trap: 16 printed in base 16 is `10`.
    expect(await runBc('obase=16; obase\n')).toEqual({ out: '10\n', err: '', exitCode: 0 })
    // Fractional digits come out in the output base too.
    expect(await runBc('obase=16; scale=4; 1/3\n')).toEqual({
      out: '.5553\n',
      err: '',
      exitCode: 0,
    })
  })

  it('an obase above sixteen prints two-digit groups', async () => {
    // GNU prints a base above 16 as space-separated decimal groups,
    // with a leading space: 255 at base 100 is exactly ` 02 55`.
    expect(await runBc('obase=100; 255\n')).toEqual({ out: ' 02 55\n', err: '', exitCode: 0 })
  })

  it('a clamped register warns and still exits 0', async () => {
    expect(await runBc('ibase=1; ibase\n')).toEqual({
      out: '2\n',
      err: 'Runtime warning (func=(main), adr=3): ibase too small, set to 2\n',
      exitCode: 0,
    })
    expect(await runBc('obase=0; 5\n')).toEqual({
      out: '101\n',
      err: 'Runtime warning (func=(main), adr=3): obase too small, set to 2\n',
      exitCode: 0,
    })
    // GNU reports adr=4 for this one; the address is an internal
    // bytecode offset and is documented as not worth matching on, so
    // both hosts print the same constant everywhere.
    expect(await runBc('scale=-1; scale\n')).toEqual({
      out: '0\n',
      err: 'Runtime warning (func=(main), adr=3): negative scale, set to 0\n',
      exitCode: 0,
    })
  })

  // -- Section M: a parse error is not fatal and the exit code is 0 ---

  it('an incomplete construct is charged to the next line', async () => {
    // Line 1 is a legal prefix, so the parser only fails when line 2
    // (here, the end of the input) arrives.
    expect(await runBc('(1+2\n')).toEqual({
      out: '',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1+\n')).toEqual({
      out: '',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('scale=\n')).toEqual({
      out: '',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
  })

  it('an unexpected token is charged to its own line', async () => {
    for (const text of ['1+2)\n', '1 2\n', '1.2.3\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
  })

  it('an illegal character has its own wording', async () => {
    expect(await runBc('@\n')).toEqual({
      out: '',
      err: '(standard_in) 1: illegal character: @\n',
      exitCode: 0,
    })
  })

  it('evaluation continues after a parse error', async () => {
    expect(await runBc('(1+2\n3+4\n')).toEqual({
      out: '7\n',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1 2\n5+5\n')).toEqual({
      out: '10\n',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('line numbers are absolute within the invocation', async () => {
    expect(await runBc('1+1\n@\n2+2\n')).toEqual({
      out: '2\n4\n',
      err: '(standard_in) 2: illegal character: @\n',
      exitCode: 0,
    })
    expect(await runBc('1 2\n3 4\n9+9\n')).toEqual({
      out: '18\n',
      err: '(standard_in) 1: syntax error\n(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
  })

  // -- Section W: comments, quit/halt, the builtins and ++ tokenization

  it('a hash comment runs to the end of the line', async () => {
    expect(await runBc('# comment\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('1+1 # trailing\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('1+1#c\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    // The newline is still the statement terminator, so the next line is
    // a separate statement rather than being glued on.
    expect(await runBc('1+1 #c\n2+2\n')).toEqual({ out: '2\n4\n', err: '', exitCode: 0 })
  })

  it('a comment does not split on its semicolons', async () => {
    // The statement splitter cuts on `;`, so comment removal has to come
    // first or a `;` inside a comment would cut the line in half.
    expect(await runBc('1+1 # a;b;c\n2+2\n')).toEqual({ out: '2\n4\n', err: '', exitCode: 0 })
    expect(await runBc('1;#c;2\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
  })

  it('a comment line still advances the line counter', async () => {
    // The whole reason comments matter for diagnostics: GNU charges the
    // second illegal character to line 3, not line 2.
    expect(await runBc('@\n#nope\n$\n')).toEqual({
      out: '',
      err: '(standard_in) 1: illegal character: @\n(standard_in) 3: illegal character: $\n',
      exitCode: 0,
    })
    expect(await runBc('1+1 #c\n@\n')).toEqual({
      out: '2\n',
      err: '(standard_in) 2: illegal character: @\n',
      exitCode: 0,
    })
  })

  it('block comments separate tokens rather than vanishing', async () => {
    expect(await runBc('/* block */ 1+1\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('1+/*c*/2\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('x/*c*/=5;x\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
    // `1/*c*/2` is `1 2`, so it is a syntax error rather than `12`.
    expect(await runBc('1/*c*/2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('a block comment spanning lines advances the counter', async () => {
    // The comment's newlines count, but they do not end the statement.
    expect(await runBc('1+1/*\n*/+1\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('/*\nmulti\n*/@\n')).toEqual({
      out: '',
      err: '(standard_in) 3: illegal character: @\n',
      exitCode: 0,
    })
    // The illegal character sits on line 2 although its statement starts
    // on line 1, which is why the diagnostic maps an offset to a line.
    expect(await runBc('1+1/*\n*/ @\n')).toEqual({
      out: '',
      err: '(standard_in) 2: illegal character: @\n',
      exitCode: 0,
    })
  })

  it('an unterminated block comment has its own wording', async () => {
    // GNU reports this one with no input name and no line number, and
    // the statements it was still reading never run.
    expect(await runBc('1+1\n/* unterminated\n')).toEqual({
      out: '2\n',
      err: 'EOF encountered in a comment.\n',
      exitCode: 0,
    })
  })

  it('quit ends the run at lex time', async () => {
    expect(await runBc('quit\n')).toEqual({ out: '', err: '', exitCode: 0 })
    // Earlier lines have already printed; later ones are never read.
    expect(await runBc('1+1\nquit\n2+2\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    // Nothing after it on its own line is even scanned, so neither the
    // trailing expression nor the illegal character is reported.
    expect(await runBc('quit 1+1\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('quit@\n')).toEqual({ out: '', err: '', exitCode: 0 })
  })

  it('a line a quit cuts short is parsed but not executed', async () => {
    // GNU compiles a line and runs it at its newline, and `quit` exits
    // before that newline arrives, so `1+1` never prints and `1/0` never
    // divides -- but a syntax error on the same line is still reported.
    expect(await runBc('1+1;quit\n3+3\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('1/0;quit\n3+3\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('1 2;quit\n3+3\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('quit is only a whole word and never inside a comment', async () => {
    expect(await runBc('quitx\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('1+1 #quit\n2+2\n')).toEqual({ out: '2\n4\n', err: '', exitCode: 0 })
    expect(await runBc('/*quit*/1+1\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
  })

  it('quit anywhere but a statement start is also a syntax error', async () => {
    // GNU hands `quit` to the parser, which refuses it mid-expression and
    // still ends the run, so nothing after it is evaluated either.
    expect(await runBc('1 quit\n2+2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1+quit\n2+2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('halt is a runtime statement, not a lexer exit', async () => {
    expect(await runBc('halt\n')).toEqual({ out: '', err: '', exitCode: 0 })
    expect(await runBc('1+1\nhalt\n2+2\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    // The difference from `quit`: everything earlier on halt's own line
    // has already run and printed by the time halt is reached.
    expect(await runBc('1+1;halt;2+2\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('x=5;halt;x\n')).toEqual({ out: '', err: '', exitCode: 0 })
    // And nothing after it is read, so the illegal character never is.
    expect(await runBc('1+1\nhalt\n@\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
  })

  it('halt with anything after it stays a syntax error', async () => {
    // `halt` is a statement, so it is not an expression operand either.
    for (const text of ['halt 1+1\n', '1+halt\n', 'x=halt\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    expect(await runBc('haltx\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('length counts significant digits', async () => {
    expect(await runBc('length(0)\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('length(100)\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('length(-123)\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('length(1.23456)\n')).toEqual({ out: '6\n', err: '', exitCode: 0 })
    expect(await runBc('length(1.230)\n')).toEqual({ out: '4\n', err: '', exitCode: 0 })
    // The integer part's leading zeros do not count and the fraction's
    // do, so `0.5` is 1 digit and `0.05` is 2.
    expect(await runBc('length(0.5)\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('length(0.05)\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
    expect(await runBc('length(007)\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('length(0.000)\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('length(2^100)\n')).toEqual({ out: '31\n', err: '', exitCode: 0 })
  })

  it('scale of a value is the scale it carries', async () => {
    expect(await runBc('scale(0)\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('scale(1.230)\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('scale(1.23456)\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
    // A literal is not reduced, so the global scale does not touch it.
    expect(await runBc('scale=2;scale(1.23456)\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
    expect(await runBc('scale(2^100)\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('x=1.50;length(x);scale(x)\n')).toEqual({
      out: '3\n2\n',
      err: '',
      exitCode: 0,
    })
  })

  it('both builtins follow the global scale of a quotient', async () => {
    // At the default scale of 0, `1/3` is 0, so both answer for that.
    expect(await runBc('length(1/3)\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('scale(1/3)\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('scale=3;length(1/3);scale(1/3)\n')).toEqual({
      out: '3\n3\n',
      err: '',
      exitCode: 0,
    })
    // `-l` only moves the initial scale, which both builtins then see.
    expect(await runBc('length(1/3)\n', { args_l: true })).toEqual({
      out: '20\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale(1/3)\n', { args_l: true })).toEqual({
      out: '20\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('length(0)\n', { args_l: true })).toEqual({
      out: '1\n',
      err: '',
      exitCode: 0,
    })
    expect(await runBc('scale(0)\n', { args_l: true })).toEqual({
      out: '0\n',
      err: '',
      exitCode: 0,
    })
  })

  it('a builtin needs its argument and only one', async () => {
    for (const text of ['length()\n', 'scale()\n', 'length(1,2)\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    // `scale` stays a readable register when no `(` follows it.
    expect(await runBc('scale\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('length=2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('a builtin without its paren is an incomplete construct', async () => {
    // A legal prefix, so GNU charges the failure to the next line -- the
    // same rule `sqrt` follows.
    for (const text of ['length\n', 'sqrt\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 2: syntax error\n',
        exitCode: 0,
      })
    }
  })

  it('double signs are one token each', async () => {
    // GNU's lexer reads `++` and `--` as single tokens, so `1++2` is a
    // syntax error rather than `1 + (+2)`.
    for (const text of ['1++2\n', '1--2\n', '1+++2\n', '1---2\n', '1++\n', '5++2\n', '5++\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    // A separated sign is not the doubled token, and `-` is the only
    // unary sign there is, so `1- -2` works where `1+ +2` does not.
    expect(await runBc('1- -2\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
    expect(await runBc('1+ +2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    // A postfix step still binds to its name, so these keep working.
    expect(await runBc('x=5; x++ + 1\n')).toEqual({ out: '6\n', err: '', exitCode: 0 })
    expect(await runBc('x=5;x+++1;x\n')).toEqual({ out: '6\n6\n', err: '', exitCode: 0 })
  })

  it('there is no unary plus', async () => {
    for (const text of ['+5\n', '2-+3\n', '(+5)\n', 'x=+5\n', '++5\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    // Unary minus does exist, so these are the control rows.
    expect(await runBc('-5\n')).toEqual({ out: '-5\n', err: '', exitCode: 0 })
    expect(await runBc('2+-3\n')).toEqual({ out: '-1\n', err: '', exitCode: 0 })
  })

  it('a bare sign charges the two to different lines', async () => {
    // `+` cannot start an expression at all, so it is charged to its own
    // line; `-` is a legal prefix, so it is charged to the next one.
    expect(await runBc('+\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('-\n')).toEqual({
      out: '',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
  })

  it('prefix and postfix steps on an undefined name', async () => {
    expect(await runBc('++x\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
    expect(await runBc('x++\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
    expect(await runBc('--x\n')).toEqual({ out: '-1\n', err: '', exitCode: 0 })
    expect(await runBc('x--\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  // -- Section Z: a parse error discards the whole line ---------------
  // GNU compiles one input line and runs it at its newline, so a
  // statement that will not parse means none of that line ever ran. The
  // parse diagnostics are the exception: GNU still reports one per bad
  // statement.

  it('a parse error discards the whole line', async () => {
    for (const text of ['1 2;5+5\n', '5+5;1 2\n', 'x=5;1 2;x\n', 'scale=2;7/2;1 2\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    // Only the bad line is discarded; the next one still runs.
    expect(await runBc('1 2; 5+5\n9+9\n')).toEqual({
      out: '18\n',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1+1;1 2\n2+2\n')).toEqual({
      out: '4\n',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('each bad statement on a line still reports', async () => {
    // The discard is about output, not diagnostics: two bad statements on
    // one line are two syntax errors, both charged to that line.
    expect(await runBc('1 2;3 4\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1 2;3 4;5 6\n')).toEqual({
      out: '',
      err:
        '(standard_in) 1: syntax error\n' +
        '(standard_in) 1: syntax error\n' +
        '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
  })

  it('a discarded line rolls back every write', async () => {
    // None of the line ran, so neither did its assignments -- the symbol
    // table and all three registers go back to what they were.
    expect(await runBc('x=5;1 2\nx\n')).toEqual({
      out: '0\n',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect((await runBc('x=5;x=6;1 2\nx\n')).out).toBe('0\n')
    expect((await runBc('ibase=1;1 2\nibase\n')).out).toBe('10\n')
    expect((await runBc('scale=3;1 2\nscale\n')).out).toBe('0\n')
    expect((await runBc('obase=16;1 2\nobase;255\n')).out).toBe('10\n255\n')
    expect((await runBc('1+1; last;1 2\nlast\n')).out).toBe('0\n')
    expect((await runBc('x=5;@\nx\n')).out).toBe('0\n')
  })

  it('a discarded line suppresses its runtime diagnostics', async () => {
    // The line never ran, so its divide by zero, its unknown function and
    // its clamped register never happened either.
    const texts = ['1/0;1 2\n', '1 2;1/0\n', 'foo(1);1 2\n', '1 2;foo(1)\n', 'ibase=1;1 2\n']
    for (const text of texts) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
  })

  it('a runtime error alone discards nothing', async () => {
    // Only a *parse* failure discards. A runtime error is non-fatal, the
    // values already printed on its line stay printed, and the writes
    // already made stay made.
    expect(await runBc('2+2;1/0\n')).toEqual({
      out: '4\n',
      err: 'Runtime error (func=(main), adr=3): Divide by zero\n',
      exitCode: 0,
    })
    expect((await runBc('x=5;1/0\nx\n')).out).toBe('5\n')
    expect((await runBc('ibase=1;1+1;ibase\n')).out).toBe('2\n2\n')
  })

  it('the discarded unit is the logical line', async () => {
    // A block comment stretches one statement list over two input lines,
    // and the whole list is still one unit: the `1+1` is discarded by the
    // illegal character that sits on input line 2.
    expect(await runBc('1+1/*\n*/;@\nx\n')).toEqual({
      out: '0\n',
      err: '(standard_in) 2: illegal character: @\n',
      exitCode: 0,
    })
  })

  it('a halt on a discarded line does not run', async () => {
    // GNU compiles the whole line before running any of it, so a halt on
    // a line that does not parse never happens and the run carries on.
    expect(await runBc('1+1;halt;1 2\n3+3\n')).toEqual({
      out: '6\n',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect((await runBc('1 2;halt\n3+3\n')).out).toBe('6\n')
    expect((await runBc('halt;1 2\n3+3\n')).out).toBe('6\n')
    // And a halt on a line that does parse still ends the run.
    expect(await runBc('1+1;halt;2+2\n3+3\n')).toEqual({ out: '2\n', err: '', exitCode: 0 })
  })

  it('the discard does not disturb quit', async () => {
    // A `quit` line is already never executed, so the only thing the
    // discard adds is that its parse errors are still reported.
    expect(await runBc('x=5;1 2;quit\nx\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect(await runBc('1+1;quit;1 2\n')).toEqual({ out: '', err: '', exitCode: 0 })
    // An earlier line's output is still safe from both of them.
    expect((await runBc('1+1\n2+2\n1 2;x\n3+3\n')).out).toBe('2\n4\n6\n')
    expect((await runBc('1+1\n2+2\nquit\n3+3\n')).out).toBe('2\n4\n')
  })

  // -- Section Y: a runtime error is fatal WITHIN its line ------------
  // It stays non-fatal across lines, which is the older finding: the two
  // rules are about different scopes, and only a parse error rolls back.

  it('a runtime error abandons the rest of its line', async () => {
    expect(await runBc('1/0;2+2\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Divide by zero\n',
      exitCode: 0,
    })
    // Non-fatal across lines, as before: the next line still runs.
    expect((await runBc('1/0;2+2\n3+3\n')).out).toBe('6\n')
    // A statement before the error keeps its printed value.
    expect((await runBc('2+2;1/0\n')).out).toBe('4\n')
    expect((await runBc('1+1;1/0;2+2\n')).out).toBe('2\n')
  })

  it('a runtime error stops execution without rolling back', async () => {
    // The decisive row: `x=5` stays written and `y=7` never runs, so a
    // runtime error is not the parse error's all-or-nothing rollback.
    expect((await runBc('x=5;1/0;y=7\nx\ny\n')).out).toBe('5\n0\n')
    expect((await runBc('1/0;x=5\nx\n')).out).toBe('0\n')
    expect((await runBc('ibase=16;1/0;FF\nibase\n')).out).toBe('16\n')
    expect((await runBc('scale=3;1/0\nscale\n')).out).toBe('3\n')
  })

  it('an undefined function abandons the line the same way', async () => {
    expect(await runBc('1+1;foo(1);2+2\n')).toEqual({
      out: '2\n',
      err: 'Runtime error (func=(main), adr=3): Function foo not defined.\n',
      exitCode: 0,
    })
    expect((await runBc('s(0);2+2\n')).out).toBe('')
  })

  it('a runtime warning is not an error and abandons nothing', async () => {
    // `ibase=1` warns and carries on, where `1/0` stops the line.
    expect(await runBc('ibase=1;2+2\n')).toEqual({
      out: '4\n',
      err: 'Runtime warning (func=(main), adr=3): ibase too small, set to 2\n',
      exitCode: 0,
    })
    expect((await runBc('ibase=1;1+1;ibase\n')).out).toBe('2\n2\n')
  })

  it('a runtime error stops a later halt on its line', async () => {
    // The halt never runs, so the run carries on to the next line.
    expect((await runBc('1/0;halt;2+2\n3+3\n')).out).toBe('6\n')
    expect((await runBc('1+1;1/0;halt\n3+3\n')).out).toBe('2\n6\n')
    // The other order: halt first, so the division never happens.
    expect(await runBc('halt;1/0\n3+3\n')).toEqual({ out: '', err: '', exitCode: 0 })
    // And a `quit` line never runs at all, error included.
    expect(await runBc('1/0;quit\n3+3\n')).toEqual({ out: '', err: '', exitCode: 0 })
  })

  it('a parse error still outranks a runtime one on its line', async () => {
    expect(await runBc('1/0;1 2\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n',
      exitCode: 0,
    })
    expect((await runBc('1/0;3 4\n5+5\n')).out).toBe('10\n')
  })

  // -- Section Y: an incomplete construct is charged to its terminator

  it('an incomplete construct followed by a semicolon', async () => {
    // GNU's parser fails on whichever token arrives next. A `;` sits on
    // the current line, so the diagnostic does too -- where a newline has
    // already moved the counter on.
    const texts = [
      '(1+;x=5\n',
      '1+;2\n',
      'scale=;x\n',
      '1+;\n',
      '1+;;\n',
      'sqrt;1\n',
      'length;1\n',
      '-;1\n',
      '1+ ;2\n',
      'x=5;1+;y=6\n',
      '(1+2;3\n',
    ]
    for (const text of texts) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 1: syntax error\n',
        exitCode: 0,
      })
    }
    // The line is discarded too, so the assignment before it is undone.
    expect((await runBc('(1+;x=5\nx\n')).out).toBe('0\n')
  })

  it('the last statement of a line is still charged to the next', async () => {
    // The control rows: nothing follows, so the newline is the token that
    // fails and it has already moved the counter on.
    for (const text of ['x=5;(1+\n', '1+\n', 'scale=\n', '(1+2\n', 'x=5;-\n', '-\n']) {
      expect(await runBc(text)).toEqual({
        out: '',
        err: '(standard_in) 2: syntax error\n',
        exitCode: 0,
      })
    }
  })

  it('the terminating semicolon carries its own line', async () => {
    // A block comment moves the `;` onto input line 2, and the diagnostic
    // follows it there rather than staying with the statement's start.
    expect(await runBc('1+/*\n*/;2\n')).toEqual({
      out: '',
      err: '(standard_in) 2: syntax error\n',
      exitCode: 0,
    })
    // An illegal character after such a `;` is still reported by itself,
    // and both diagnostics land on line 1.
    expect(await runBc('1+;@\n')).toEqual({
      out: '',
      err: '(standard_in) 1: syntax error\n(standard_in) 1: illegal character: @\n',
      exitCode: 0,
    })
  })
})

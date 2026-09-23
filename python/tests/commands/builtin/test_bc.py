# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws():
    mem = RAMVFS()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_bc_add():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "bc", stdin=b"2+3")
    assert _bytes(stdout).strip() == b"5"


def test_bc_multiply():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "bc", stdin=b"6*7")
    assert _bytes(stdout).strip() == b"42"


def _stderr_text(io):
    err = io.stderr
    if err is None:
        return ""
    return err.decode() if isinstance(err, bytes) else str(err)


def _out(cmd, stdin):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, cmd, stdin=stdin)
    return (b"" if stdout is None else _bytes(stdout)), io


def test_bc_default_scale_is_zero_so_division_truncates():
    # GNU: default scale is 0, so `7/2` is 3 and `-7/2` is -3 --
    # truncation toward zero, not floor.
    assert _out("bc", b"scale\n")[0] == b"0\n"
    assert _out("bc", b"7/2\n")[0] == b"3\n"
    assert _out("bc", b"-7/2\n")[0] == b"-3\n"


def test_bc_modulo_takes_the_dividend_sign():
    assert _out("bc", b"7%2\n")[0] == b"1\n"
    assert _out("bc", b"-7%2\n")[0] == b"-1\n"


def test_bc_scale_assignment_pads_the_quotient():
    # GNU prints the trailing zero: `3.50`, not `3.5`.
    assert _out("bc", b"scale=2; 7/2\n")[0] == b"3.50\n"


def test_bc_sum_keeps_the_wider_operand_scale():
    # `0.1+0.2` is `.3` at the default scale of 0, because addition keeps
    # its operands' scale -- and GNU omits the leading zero.
    assert _out("bc", b"0.1+0.2\n")[0] == b".3\n"


def test_bc_power_and_parentheses():
    assert _out("bc", b"2^10\n")[0] == b"1024\n"
    assert _out("bc", b"(1+2)*3\n")[0] == b"9\n"


def test_bc_power_is_exact_where_float64_is_exact():
    # Repeated squaring on a base and a result float64 represents
    # exactly is exact, so these are GNU's answers byte for byte
    # (measured on bc 1.07.1).
    assert _out("bc", b"2^31\n")[0] == b"2147483648\n"
    assert _out("bc", b"2^62\n")[0] == b"4611686018427387904\n"
    # 10^22 is the largest power of ten float64 holds exactly; 10^23 is
    # not one, and neither host can print GNU's answer for it.
    assert _out("bc", b"10^22\n")[0] == b"10000000000000000000000\n"
    assert _out("bc", b"3^5\n")[0] == b"243\n"
    assert _out("bc", b"2^100\n")[0] == b"1267650600228229401496703205376\n"


def test_bc_power_of_a_fractional_base_agrees_between_the_hosts():
    # The divergence the in-tree power exists to close: `pow` through
    # glibc and through V8 are one ulp apart here, and the renderer
    # prints the shortest digits that read back as the double, so the
    # ulp reached stdout as 24257295885134.4570 against .4530. Both
    # hosts now multiply in one order. The value stays float64-limited:
    # GNU, which is exact decimal, answers 24257295885134.4544 (and
    # 821783259531709.90), and no double can carry that.
    assert _out("bc", b"7.8041^15\n")[0] == b"24257295885134.4650\n"
    assert _out("bc", b"9.87^15\n")[0] == b"821783259531708.90\n"


def test_bc_power_scale_rules_are_gnus():
    # Measured: a non-negative exponent gives the result
    # `min(scale(base)*exponent, max(scale, scale(base)))` fractional
    # digits, so the global scale does not truncate a power down to it,
    # while a negative exponent adopts the global scale outright.
    assert _out("bc", b"scale=0; 1.1^3\n")[0] == b"1.3\n"
    assert _out("bc", b"scale=0; 2.5^2\n")[0] == b"6.2\n"
    assert _out("bc", b"scale=0; (-1.5)^3\n")[0] == b"-3.3\n"
    assert _out("bc", b"scale=7; 1.05^3\n")[0] == b"1.157625\n"
    assert _out("bc", b"scale=0; 0.1^3\n")[0] == b"0\n"
    assert _out("bc", b"scale=3; 0.1^3\n")[0] == b".001\n"
    assert _out("bc", b"2^-3\n")[0] == b"0\n"
    assert _out("bc", b"scale=3; 2^-3\n")[0] == b".125\n"
    assert _out("bc", b"scale=3; 1.5^-2\n")[0] == b".444\n"
    assert _out("bc", b"2^0\n")[0] == b"1\n"
    assert _out("bc", b"0^0\n")[0] == b"1\n"


def test_bc_a_non_integer_exponent_is_truncated_with_a_warning():
    # GNU truncates the exponent toward zero and warns whenever the
    # value it truncated carried a scale at all -- `2^1.0` warns
    # although its value is whole -- so the test of the warning is the
    # operand's scale, not its fraction.
    stdout, io = _out("bc", b"2^1.5\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == ("Runtime warning (func=(main), adr=3): "
                                "non-zero scale in exponent\n")
    stdout, io = _out("bc", b"2^1.0\n")
    assert stdout == b"2\n"
    assert "non-zero scale in exponent" in _stderr_text(io)
    # `3/2` is 1 at scale 0, an exponent with no scale, so no warning.
    stdout, io = _out("bc", b"2^(3/2)\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == ""
    # `^` is right associative, so this is 2^(2.5^2) = 2^6.
    assert _out("bc", b"2^2.5^2\n")[0] == b"64\n"


def test_bc_zero_to_a_negative_power_is_a_lowercase_divide_by_zero():
    # GNU words this one in lowercase where `1/0` is capitalised: the
    # two are raised from different places in its source.
    stdout, io = _out("bc", b"0^-1\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): divide by zero\n")
    assert io.exit_code == 0
    # The exponent warning is reported before the refusal.
    stdout, io = _out("bc", b"0^-1.5\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime warning (func=(main), adr=3): "
        "non-zero scale in exponent\n"
        "Runtime error (func=(main), adr=3): divide by zero\n")


def test_bc_sqrt_needs_no_math_library():
    # GNU has sqrt built in; only s/c/a/l/e come from -l.
    assert _out("bc", b"sqrt(4)\n")[0] == b"2\n"


def test_bc_sqrt_of_one_is_a_bare_one_at_every_scale():
    # GNU's `bc_sqrt` short-circuits an argument of exactly one to its
    # own canonical one, which carries no scale. The rule is narrower
    # than "a perfect square" and narrower than "an exact result": every
    # other exact root is padded to the result scale, and so is the math
    # library's own one. Every expectation measured on bc 1.07.1.
    assert _out("bc", b"scale=100; sqrt(1)\n")[0] == b"1\n"
    assert _out("bc", b"scale=5; sqrt(1)\n")[0] == b"1\n"
    assert _out("bc", b"scale=0; sqrt(1)\n")[0] == b"1\n"
    # It compares the value, not the digits written.
    assert _out("bc", b"scale=5; sqrt(1.00)\n")[0] == b"1\n"
    assert _out("bc", b"scale=5; sqrt(3/3)\n")[0] == b"1\n"
    assert _out("bc", b"scale=5; sqrt(0.5*2)\n")[0] == b"1\n"
    # Every other exact root still pads, which is the narrowness.
    assert _out("bc", b"scale=5; sqrt(4)\n")[0] == b"2.00000\n"
    assert _out("bc", b"scale=5; sqrt(9)\n")[0] == b"3.00000\n"
    assert _out("bc", b"scale=5; sqrt(0.25)\n")[0] == b".50000\n"
    assert _out("bc", b"scale=5; sqrt(1.44)\n")[0] == b"1.20000\n"
    # And so does a one the math library produced, so it is `sqrt`'s
    # rule and not a rule about the value one.
    assert _out("bc -l", b"scale=5; c(0)\n")[0] == b"1.00000\n"
    # A hair off one is not one.
    assert _out("bc", b"scale=5; sqrt(1.0000001)\n")[0] == b"1.0000000\n"


def test_bc_sqrt_of_one_carries_scale_zero_not_just_a_short_rendering():
    # The short-circuit gives the result a real scale of 0, which is
    # observable through `scale()`, through `length()`, and through a
    # division that adopts the global scale instead.
    assert _out("bc", b"scale=5; scale(sqrt(1))\n")[0] == b"0\n"
    assert _out("bc", b"scale=5; length(sqrt(1))\n")[0] == b"1\n"
    assert _out("bc", b"scale=5; sqrt(1)/1\n")[0] == b"1.00000\n"
    # A bare `length`/`scale` is untouched by it: `scale(1.00)` is still
    # the literal's own 2 and `length(1.230)` its own 4.
    assert _out("bc", b"scale=5; scale(1.00)\n")[0] == b"2\n"
    assert _out("bc", b"scale=5; length(1.230)\n")[0] == b"4\n"
    assert _out("bc", b"scale=5; scale(sqrt(4))\n")[0] == b"5\n"


def test_bc_sqrt_of_a_negative_number_is_refused():
    # GNU reports it rather than answering a NaN, keeps going, and still
    # exits 0. Only the bytecode address differs from GNU's, which is
    # the file-wide `RUNTIME_ERROR_ADDR` divergence (GNU says 4 here).
    stdout, io = _out("bc", b"sqrt(-1)\n")
    assert stdout == b""
    assert _stderr_text(io) == ("Runtime error (func=(main), adr=3): "
                                "Square root of a negative number\n")
    assert io.exit_code == 0
    # Inside a larger expression it abandons the rest of its line.
    assert _out("bc", b"1+sqrt(-1)\n")[0] == b""
    # A later line still runs, as after any runtime error.
    assert _out("bc", b"sqrt(-1)\n2+2\n")[0] == b"4\n"


# -- The 70-column fold ------------------------------------------------
# GNU writes a printed value a character at a time and breaks with a
# backslash and a newline when the column reaches `line_size`, so a
# folded line carries `line_size - 2` characters of the value. Every
# expectation below is real bc 1.07.1's output byte for byte, and every
# value is one float64 carries exactly, so none of it is confounded by
# the precision gap.

POWER_300 = (b"2037035976334486086268445688409378161051468393665936250636"
             b"1404493543"
             b"\\\n"
             b"81299763336706183397376\n")
UNFOLDED_300 = POWER_300.replace(b"\\\n", b"")


def test_bc_a_long_value_folds_at_sixty_eight_characters():
    # 2^300 is 91 digits: 68 of them, a backslash, then the other 23.
    assert _out("bc", b"2^300\n")[0] == POWER_300
    assert _out("bc", b"obase=2; 2^100\n")[0] == (b"1" + b"0" * 67 + b"\\\n" +
                                                  b"0" * 33 + b"\n")


def test_bc_the_fold_boundary_is_sixty_eight_characters_of_value():
    # 2^-67 renders as 68 characters and does not fold; 2^-68 renders as
    # 69 and folds, leaving one character on the second line. Both are
    # powers of two, so their expansions are exact at these scales.
    assert _out("bc", b"scale=67; 2^-67\n")[0] == (
        b".00000000000000000000677626357803440271254658000543713569641113"
        b"28125\n")
    assert _out("bc", b"scale=68; 2^-68\n")[0] == (
        b".00000000000000000000338813178901720135627329000271856784820556"
        b"64062\\\n5\n")


def test_bc_the_fold_column_is_counted_per_value():
    # A short value printed after a folded one starts at the left margin
    # again, because GNU's column resets on the newline it just wrote.
    assert _out("bc", b"2^300; 1+1\n")[0] == POWER_300 + b"2\n"


def test_bc_a_long_diagnostic_does_not_fold():
    # 118 characters on one line: the fold is the printed value's, not
    # the output stream's.
    stdout, io = _out("bc", b"f" * 60 + b"(1)\n")
    assert stdout == b""
    assert _stderr_text(io) == ("Runtime error (func=(main), adr=3): "
                                "Function " + "f" * 60 + " not defined.\n")


def test_bc_line_length_sets_the_fold_width():
    # `BC_LINE_LENGTH=0` turns folding off outright, and any other width
    # puts `width - 2` characters on a line. Measured against GNU.
    assert _out("BC_LINE_LENGTH=0 bc", b"2^300\n")[0] == UNFOLDED_300
    digits = UNFOLDED_300.rstrip(b"\n")
    chunks = [digits[at:at + 8] for at in range(0, len(digits), 8)]
    assert _out("BC_LINE_LENGTH=10 bc",
                b"2^300\n")[0] == b"\\\n".join(chunks) + b"\n"


def test_bc_line_length_is_read_the_way_c_reads_it():
    # GNU reads it with `atoi`, so trailing garbage is ignored and a
    # value with no digits at all reads as 0, which turns folding off. A
    # width below 3 that is not 0 falls back to the default, and the
    # value is truncated to a C `int`, which is why 4294967296 reads as
    # 0 and 2147483648 does not. Every row measured against GNU.
    for value, want in (("abc", UNFOLDED_300), ("0x46", UNFOLDED_300),
                        ("", UNFOLDED_300), ("4294967296", UNFOLDED_300),
                        ("70", POWER_300), ("+70", POWER_300),
                        ("-1", POWER_300), ("1e3", POWER_300),
                        ("2", POWER_300), ("2147483648", POWER_300),
                        ("9223372036854775808",
                         POWER_300), ("99999999999999999999", POWER_300)):
        line = f"BC_LINE_LENGTH={value} bc"
        assert _out(line, b"2^300\n")[0] == want, value


def test_bc_divide_by_zero_is_non_fatal_and_keeps_evaluating():
    # GNU prints the runtime error on stderr, still evaluates the next
    # statement, and exits 0.
    stdout, io = _out("bc", b"1/0\n2+2\n")
    assert stdout == b"4\n"
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0


def test_bc_divide_by_zero_alone_prints_nothing_on_stdout():
    stdout, io = _out("bc", b"1/0\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0


def test_bc_modulo_by_zero_has_its_own_wording():
    stdout, io = _out("bc", b"1%0\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Modulo by zero\n")
    assert io.exit_code == 0


def test_bc_math_library_sets_scale_to_twenty():
    # -l loads the math library, which sets scale to 20, so `7/2` stops
    # truncating.
    assert _out("bc -l", b"scale\n")[0] == b"20\n"
    assert _out("bc -l", b"7/2\n")[0] == b"3.50000000000000000000\n"


def test_bc_math_library_exact_zero_is_not_padded():
    # GNU prints a bare `0` for an exact zero whatever the scale, so
    # `s(0)` and `l(1)` are `0` rather than `0.000...`.
    assert _out("bc -l", b"s(0)\n")[0] == b"0\n"
    assert _out("bc -l", b"l(1)\n")[0] == b"0\n"


def test_bc_math_library_exact_one_is_padded():
    assert _out("bc -l", b"c(0)\n")[0] == b"1.00000000000000000000\n"


def test_bc_math_library_irrationals_are_float64_limited():
    # These are the three ground-truth values float64 cannot reach.
    # GNU (arbitrary precision) prints:
    #   sqrt(2) 1.41421356237309504880
    #   a(1)     .78539816339744830961
    #   e(1)    2.71828182845904523536
    # Both hosts share one float64 model (TypeScript has no bigdecimal
    # in-tree), so both print the shortest digits that read back as the
    # double and pad the rest with zeros -- float64 carries about 17
    # significant digits and nothing beyond them is information.
    # `a(1)` and `e(1)` come from the in-tree series rather than from a
    # libm, so their last bit is the series' and not glibc's: one ulp
    # either way, and the same ulp in both hosts, which is the point.
    # At any scale up to 15 both are GNU's answer exactly (below).
    assert _out("bc -l", b"sqrt(2)\n")[0] == b"1.41421356237309510000\n"
    assert _out("bc -l", b"a(1)\n")[0] == b".78539816339744840000\n"
    assert _out("bc -l", b"e(1)\n")[0] == b"2.71828182845904550000\n"


def test_bc_math_library_matches_gnu_up_to_scale_fifteen():
    # float64 carries about 17 significant digits, so every one of these
    # is GNU bc 1.07.1's own output byte for byte (measured); the gap
    # only opens past a scale of 15, where GNU keeps going and the
    # doubles have run out of information.
    assert _out("bc -l", b"scale=15; s(1)\n")[0] == b".841470984807896\n"
    assert _out("bc -l", b"scale=15; c(.1)\n")[0] == b".995004165278025\n"
    assert _out("bc -l", b"scale=15; l(3)\n")[0] == b"1.098612288668109\n"
    assert _out("bc -l", b"scale=15; a(1)\n")[0] == b".785398163397448\n"
    assert _out("bc -l", b"scale=15; e(1)\n")[0] == b"2.718281828459045\n"
    assert _out("bc -l", b"scale=10; s(1)\n")[0] == b".8414709848\n"
    assert _out("bc -l", b"scale=10; c(1)\n")[0] == b".5403023058\n"
    assert _out("bc -l", b"scale=10; a(2)\n")[0] == b"1.1071487177\n"
    assert _out("bc -l", b"scale=10; l(10)\n")[0] == b"2.3025850929\n"
    assert _out("bc -l", b"scale=10; e(2)\n")[0] == b"7.3890560989\n"


def test_bc_math_library_is_computed_from_series_not_libm():
    # The divergence these series exist to close: `math.cos(.1)` and
    # `Math.cos(.1)` are one ulp apart, and the renderer prints the
    # shortest digits that read back as the double, so the ulp reached
    # stdout. The two hosts now compute the same double, which is what
    # `integ/runners/parity.py` compares; the value is float64-limited
    # either way (GNU: .99500416527802576609 and 1.09861228866810969139).
    assert _out("bc -l", b"c(.1)\n")[0] == b".99500416527802570000\n"
    assert _out("bc -l", b"l(3)\n")[0] == b"1.09861228866810980000\n"


def test_bc_math_library_answers_a_non_finite_argument():
    # `2^10000` leaves float64's range, and the reductions have to
    # refuse such an argument rather than iterate on it: the log's
    # square-root loop and the trigonometric quadrant reduction both run
    # forever on an infinity. GNU is arbitrary precision and has no
    # infinity at all, so there is nothing to match but the other host.
    assert _out("bc -l", b"l(2^10000)\n")[0] == b"Infinity\n"
    assert _out("bc -l", b"s(2^10000)\n")[0] == b"NaN\n"
    assert _out("bc -l", b"c(2^10000)\n")[0] == b"NaN\n"
    assert _out("bc -l", b"e(2^10000)\n")[0] == b"Infinity\n"
    assert _out("bc -l", b"e(0-2^10000)\n")[0] == b"0\n"
    assert _out("bc -l", b"a(2^10000)\n")[0] == b"1.57079632679489660000\n"
    # `2^10000-2^10000` is the NaN -- an infinity less itself -- and
    # every function carries it through. (`sqrt(-1)` used to be how to
    # write one; GNU refuses that, so it is a runtime error now.)
    for call in (b"l", b"s", b"c", b"a", b"e"):
        assert _out("bc -l", call + b"(2^10000-2^10000)\n")[0] == b"NaN\n"


def test_bc_log_of_a_non_positive_argument_answers_from_scale():
    # GNU's libmath.b `l(x)` returns `(1 - 10^scale)/1` for x <= 0
    # rather than refusing, and float64 carries that exactly to a scale
    # of 15. Measured: `scale=5; l(0)` and `scale=5; l(-1)`.
    assert _out("bc -l", b"scale=5; l(0)\n")[0] == b"-99999.00000\n"
    assert _out("bc -l", b"scale=5; l(-1)\n")[0] == b"-99999.00000\n"
    assert _out("bc -l", b"scale=0; l(0)\n")[0] == b"0\n"


def test_bc_does_not_evaluate_python():
    # The regression this rewrite exists for: `bc` used to run eval() on
    # agent-typed text, so any python expression executed. A leading `_`
    # is not a name character, so GNU stops at the very first one.
    stdout, io = _out("bc", b'__import__("os").getcwd()\n')
    assert stdout == b""
    assert io.exit_code == 0
    assert "(standard_in) 1: illegal character: _" in _stderr_text(io)


def test_bc_math_function_without_the_library_is_undefined():
    # GNU: `s` is not a name bc knows without -l, and a call to an
    # unknown function is the runtime shape, with a trailing period.
    stdout, io = _out("bc", b"s(0)\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Function s not defined.\n")
    assert io.exit_code == 0


# -- Section S: reducing to a scale TRUNCATES TOWARD ZERO ---------------
# Every row below distinguishes truncation from both rounding modes, and
# none of them sits on a float64 boundary where the two would agree by
# accident. `1.005` and `1.015` are deliberately absent: they are not
# exactly representable, so they test nothing.


def test_bc_product_truncates_rather_than_rounding():
    # The decisive row: 1.5*2.5 is exactly 3.75 and the product's scale
    # is 1, so it has to be reduced. Rounding either way says 3.8.
    assert _out("bc", b"1.5*2.5\n")[0] == b"3.7\n"


def test_bc_product_truncation_table():
    # 0.7*0.7 is 0.48999999999999994 in float64 and 0.49 exactly in GNU;
    # truncation answers `.4` for both reasons, rounding `.5`.
    assert _out("bc", b"0.7*0.7\n")[0] == b".4\n"
    assert _out("bc", b"0.29*0.3\n")[0] == b".08\n"
    assert _out("bc", b"1.5*2\n")[0] == b"3.0\n"


def test_bc_truncation_is_toward_zero_not_floor():
    # A floor would answer -.5 and -3.8 here.
    assert _out("bc", b"-0.7*0.7\n")[0] == b"-.4\n"
    assert _out("bc", b"-1.5*2.5\n")[0] == b"-3.7\n"
    assert _out("bc", b"1.5*-2.5\n")[0] == b"-3.7\n"
    assert _out("bc", b"0-1.5*2.5\n")[0] == b"-3.7\n"


def test_bc_quotient_truncates_rather_than_rounding():
    assert _out("bc", b"scale=1; 2/3\n")[0] == b".6\n"
    assert _out("bc", b"scale=1; 7/8\n")[0] == b".8\n"
    assert _out("bc", b"scale=0; 9/10\n")[0] == b"0\n"
    assert _out("bc", b"scale=1; 1.99/1\n")[0] == b"1.9\n"
    assert _out("bc", b"scale=1; 1.95/1\n")[0] == b"1.9\n"


def test_bc_negative_quotient_truncates_toward_zero():
    assert _out("bc", b"scale=1; -7/8\n")[0] == b"-.8\n"
    assert _out("bc", b"scale=1; -2/3\n")[0] == b"-.6\n"
    # An exact zero prints as a bare `0`, with no minus sign.
    assert _out("bc", b"scale=0; -9/10\n")[0] == b"0\n"


def test_bc_scale_zero_division_by_one_rules_out_both_rounding_modes():
    # The cleanest tie set of all: `/1` reduces a literal without
    # changing its value. 0,1,2 rules out half-to-even (0,2,2) and
    # half-up (1,2,3) at once.
    assert _out("bc", b"scale=0; 0.5/1\n")[0] == b"0\n"
    assert _out("bc", b"scale=0; 1.5/1\n")[0] == b"1\n"
    assert _out("bc", b"scale=0; 2.5/1\n")[0] == b"2\n"
    assert _out("bc", b"scale=0; -1.5/1\n")[0] == b"-1\n"


def test_bc_the_hundredth_digit_is_truncated_not_rounded():
    # A double is a dyadic rational, so its expansion is finite and gets
    # truncated exactly rather than rounded by a formatter. 2^-101 is
    # the case that proves it: its expansion is exactly 101 digits long
    # and the last one is a 5, so rounding it half to even and half away
    # from zero disagree, which is how the two hosts used to. These are
    # GNU's own 100 digits, measured, with the backslash it folds the
    # line at after 68 characters of value.
    head = "3944304526105059027058642826413931148"
    tail = "366032175545115023851394653320312"
    assert _out(
        "bc", b"scale=100; 2^-101\n")[0] == (b"." + b"0" * 30 + head.encode() +
                                             b"\\\n" + tail.encode() + b"\n")


def test_bc_power_and_function_results_truncate_too():
    assert _out("bc", b"scale=1; 1.05^3\n")[0] == b"1.15\n"
    assert _out("bc", b"scale=1; 1.5^2\n")[0] == b"2.2\n"
    assert _out("bc", b"scale=2; sqrt(0.5)\n")[0] == b".70\n"
    assert _out("bc -l", b"scale=5; l(2)\n")[0] == b".69314\n"
    assert _out("bc -l", b"scale=5; a(1)\n")[0] == b".78539\n"


def test_bc_a_literal_is_never_reduced():
    # `scale` does not touch a literal, a sum or a difference; only
    # `/`, `%`, `^`, the functions and a reducing `*` reduce.
    assert _out("bc", b"scale=0; 1.9\n")[0] == b"1.9\n"
    assert _out("bc", b"scale=0; 1.5\n")[0] == b"1.5\n"
    assert _out("bc", b"scale=0; -1.5\n")[0] == b"-1.5\n"
    assert _out("bc", b"scale=1; 1.99\n")[0] == b"1.99\n"
    assert _out("bc", b"scale=0; 1.9+0\n")[0] == b"1.9\n"
    assert _out("bc", b"scale=1; 1.25+1.25\n")[0] == b"2.50\n"


def test_bc_truncation_does_not_ride_on_a_rounded_formatter():
    # Reducing the value before formatting is what makes this right:
    # formatting 0.4999999999 at one place would round it to `.5`.
    assert _out("bc", b"scale=1; 0.4999999999/1\n")[0] == b".4\n"


# -- Section P: the symbol table ---------------------------------------


def test_bc_undefined_variable_reads_as_zero():
    assert _out("bc", b"x\n")[0] == b"0\n"
    assert _out("bc", b"x+1\n")[0] == b"1\n"
    assert _out("bc", b"q*3+1\n")[0] == b"1\n"


def test_bc_variables_survive_between_statements():
    assert _out("bc", b"x=5; x*2\n")[0] == b"10\n"
    assert _out("bc", b"abc=7\nabc+1\n")[0] == b"8\n"
    assert _out("bc", b"x=5\ny\nx+y\n")[0] == b"0\n5\n"


def test_bc_names_are_lowercase_with_digits_and_underscores():
    assert _out("bc", b"x1=3; x1\n")[0] == b"3\n"
    assert _out("bc", b"x_=1; x_\n")[0] == b"1\n"
    assert _out("bc", b"a_b=4; a_b\n")[0] == b"4\n"


def test_bc_an_assignment_prints_nothing_but_a_parenthesised_one_does():
    assert _out("bc", b"x=5\n")[0] == b""
    assert _out("bc", b"(x=5)\n")[0] == b"5\n"
    assert _out("bc", b"x=y=3; x; y\n")[0] == b"3\n3\n"


def test_bc_compound_assignments():
    assert _out("bc", b"x=1; x+=2; x\n")[0] == b"3\n"
    assert _out("bc", b"x=1; x+=2\n")[0] == b""
    assert _out("bc", b"x=10; x-=3; x\n")[0] == b"7\n"
    assert _out("bc", b"x=10; x*=3; x\n")[0] == b"30\n"
    assert _out("bc", b"x=10; x/=3; x\n")[0] == b"3\n"
    assert _out("bc", b"x=10; x%=3; x\n")[0] == b"1\n"
    assert _out("bc", b"x=10; x^=2; x\n")[0] == b"100\n"


def test_bc_increment_and_decrement_print_where_an_assignment_does_not():
    assert _out("bc", b"x=5; x++; x\n")[0] == b"5\n6\n"
    assert _out("bc", b"x=5; ++x; x\n")[0] == b"6\n6\n"
    assert _out("bc", b"x=5; x--; x\n")[0] == b"5\n4\n"
    assert _out("bc", b"x=5; --x; x\n")[0] == b"4\n4\n"
    assert _out("bc", b"x=5; y=x++; y; x\n")[0] == b"5\n6\n"
    assert _out("bc", b"x=5; y=++x; y; x\n")[0] == b"6\n6\n"


def test_bc_equals_minus_is_not_a_compound_assignment():
    # `x =- 2` is `=` followed by a negation, not the historical `-=`.
    assert _out("bc", b"x=1; x =- 2; x\n")[0] == b"-2\n"


def test_bc_a_variable_carries_its_own_scale():
    assert _out("bc", b"scale=2; x=1/3; x\n")[0] == b".33\n"
    assert _out("bc", b"x=1/3; scale=5; x\n")[0] == b"0\n"
    # The stored value is already truncated, so raising scale cannot
    # recover digits, and lowering it does not re-truncate.
    assert _out("bc", b"scale=2; x=1/3; scale=5; x\n")[0] == b".33\n"
    assert _out("bc", b"scale=2; x=1/3; scale=5; x+0\n")[0] == b".33\n"
    assert _out("bc", b"scale=5; x=1/3; scale=1; x\n")[0] == b".33333\n"
    assert _out("bc", b"scale=2; x=1/3; y=x*3; y\n")[0] == b".99\n"


def test_bc_an_assignment_does_not_reduce_a_literal():
    assert _out("bc", b"scale=2; x=1.23456; x\n")[0] == b"1.23456\n"
    assert _out("bc", b"x=1.23456; scale\n")[0] == b"0\n"


def test_bc_uppercase_letters_are_digits_not_names():
    # A single digit keeps its own value whatever ibase is; every digit
    # of a multi-digit literal is clamped to ibase-1, so `FF` is 99.
    assert _out("bc", b"A\n")[0] == b"10\n"
    assert _out("bc", b"X\n")[0] == b"33\n"
    assert _out("bc", b"Z\n")[0] == b"35\n"
    assert _out("bc", b"FF\n")[0] == b"99\n"


def test_bc_assigning_to_an_uppercase_letter_is_a_syntax_error():
    stdout, io = _out("bc", b"X=5\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0


def test_bc_a_mixed_case_name_is_a_syntax_error():
    stdout, io = _out("bc", b"aBc=1\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0


def test_bc_a_leading_underscore_is_an_illegal_character():
    stdout, io = _out("bc", b"_x=1\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: illegal character: _\n"
    assert io.exit_code == 0


def test_bc_reserved_words_are_not_names():
    for word in (b"length", b"if", b"print", b"sqrt", b"define", b"while",
                 b"for", b"auto", b"read", b"halt"):
        stdout, io = _out("bc", word + b"=1\n")
        assert stdout == b"", word
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", word
        assert io.exit_code == 0, word


def test_bc_variable_and_function_namespaces_are_separate():
    # `s` the variable does not shadow `s` the sine under -l.
    assert _out("bc -l", b"s=5; s; s(0)\n")[0] == b"5\n0\n"
    # And without -l `s` is just a variable.
    assert _out("bc", b"s=5; s\n")[0] == b"5\n"


def test_bc_an_unknown_function_is_a_runtime_error():
    stdout, io = _out("bc", b"foo(1)\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Function foo not defined.\n")
    assert io.exit_code == 0


# -- Section P5: the registers -----------------------------------------


def test_bc_register_defaults():
    assert _out("bc", b"ibase; obase; scale\n")[0] == b"10\n10\n0\n"
    assert _out("bc", b"last\n")[0] == b"0\n"


def test_bc_last_tracks_each_printed_statement():
    assert _out("bc", b"1+1; last\n")[0] == b"2\n2\n"
    assert _out("bc", b"1+1; last+1; last\n")[0] == b"2\n3\n3\n"


def test_bc_dot_is_an_alias_for_last():
    assert _out("bc", b"1+1; .\n")[0] == b"2\n2\n"
    assert _out("bc", b"x=5; .=9; last\n")[0] == b"9\n"


def test_bc_ibase_reads_literals_in_the_input_base():
    assert _out("bc", b"ibase=16; FF\n")[0] == b"255\n"
    assert _out("bc", b"ibase=16; ibase\n")[0] == b"16\n"
    assert _out("bc", b"ibase=20; J\n")[0] == b"19\n"


def test_bc_obase_prints_results_in_the_output_base():
    assert _out("bc", b"obase=16; 255\n")[0] == b"FF\n"
    assert _out("bc", b"obase=2; 10\n")[0] == b"1010\n"
    # The trap: 16 printed in base 16 is `10`.
    assert _out("bc", b"obase=16; obase\n")[0] == b"10\n"
    # Fractional digits come out in the output base too.
    assert _out("bc", b"obase=16; scale=4; 1/3\n")[0] == b".5553\n"


def test_bc_obase_above_sixteen_prints_two_digit_groups():
    # GNU prints a base above 16 as space-separated decimal groups, with
    # a leading space: 255 at base 100 is exactly ` 02 55`.
    assert _out("bc", b"obase=100; 255\n")[0] == b" 02 55\n"


def test_bc_a_clamped_register_warns_and_still_exits_zero():
    stdout, io = _out("bc", b"ibase=1; ibase\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == (
        "Runtime warning (func=(main), adr=3): ibase too small, set to 2\n")
    assert io.exit_code == 0
    stdout, io = _out("bc", b"obase=0; 5\n")
    assert stdout == b"101\n"
    assert _stderr_text(io) == (
        "Runtime warning (func=(main), adr=3): obase too small, set to 2\n")
    assert io.exit_code == 0
    # GNU reports adr=4 for this one; the address is an internal bytecode
    # offset and is documented as not worth matching on, so both hosts
    # print the same constant everywhere.
    stdout, io = _out("bc", b"scale=-1; scale\n")
    assert stdout == b"0\n"
    assert _stderr_text(io) == (
        "Runtime warning (func=(main), adr=3): negative scale, set to 0\n")
    assert io.exit_code == 0


# -- Section M: a parse error is not fatal and the exit code is 0 ------


def test_bc_an_incomplete_construct_is_charged_to_the_next_line():
    # Line 1 is a legal prefix, so the parser only fails when line 2
    # (here, the end of the input) arrives.
    stdout, io = _out("bc", b"(1+2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"
    assert io.exit_code == 0
    assert _stderr_text(_out(
        "bc", b"1+\n")[1]) == ("(standard_in) 2: syntax error\n")
    assert _stderr_text(_out(
        "bc", b"scale=\n")[1]) == ("(standard_in) 2: syntax error\n")


def test_bc_an_unexpected_token_is_charged_to_its_own_line():
    for text in (b"1+2)\n", b"1 2\n", b"1.2.3\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text


def test_bc_an_illegal_character_has_its_own_wording():
    stdout, io = _out("bc", b"@\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: illegal character: @\n"
    assert io.exit_code == 0


def test_bc_evaluation_continues_after_a_parse_error():
    stdout, io = _out("bc", b"(1+2\n3+4\n")
    assert stdout == b"7\n"
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"
    assert io.exit_code == 0
    stdout, io = _out("bc", b"1 2\n5+5\n")
    assert stdout == b"10\n"
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0


def test_bc_line_numbers_are_absolute_within_the_invocation():
    stdout, io = _out("bc", b"1+1\n@\n2+2\n")
    assert stdout == b"2\n4\n"
    assert _stderr_text(io) == "(standard_in) 2: illegal character: @\n"
    assert io.exit_code == 0
    stdout, io = _out("bc", b"1 2\n3 4\n9+9\n")
    assert stdout == b"18\n"
    assert _stderr_text(io) == ("(standard_in) 1: syntax error\n"
                                "(standard_in) 2: syntax error\n")
    assert io.exit_code == 0


# -- Section W: comments, quit/halt, the builtins and ++ tokenization -


def test_bc_hash_comment_runs_to_the_end_of_the_line():
    assert _out("bc", b"# comment\n")[0] == b""
    assert _out("bc", b"1+1 # trailing\n")[0] == b"2\n"
    assert _out("bc", b"1+1#c\n")[0] == b"2\n"
    # The newline is still the statement terminator, so the next line is
    # a separate statement rather than being glued on.
    assert _out("bc", b"1+1 #c\n2+2\n")[0] == b"2\n4\n"


def test_bc_a_comment_does_not_split_on_its_semicolons():
    # The statement splitter cuts on `;`, so comment removal has to come
    # first or a `;` inside a comment would cut the line in half.
    assert _out("bc", b"1+1 # a;b;c\n2+2\n")[0] == b"2\n4\n"
    assert _out("bc", b"1;#c;2\n")[0] == b"1\n"


def test_bc_a_comment_line_still_advances_the_line_counter():
    # The whole reason comments matter for diagnostics: GNU charges the
    # second illegal character to line 3, not line 2.
    stdout, io = _out("bc", b"@\n#nope\n$\n")
    assert stdout == b""
    assert _stderr_text(io) == ("(standard_in) 1: illegal character: @\n"
                                "(standard_in) 3: illegal character: $\n")
    assert io.exit_code == 0
    assert _stderr_text(
        _out("bc",
             b"1+1 #c\n@\n")[1]) == ("(standard_in) 2: illegal character: @\n")


def test_bc_block_comments_separate_tokens_rather_than_vanishing():
    assert _out("bc", b"/* block */ 1+1\n")[0] == b"2\n"
    assert _out("bc", b"1+/*c*/2\n")[0] == b"3\n"
    assert _out("bc", b"x/*c*/=5;x\n")[0] == b"5\n"
    # `1/*c*/2` is `1 2`, so it is a syntax error rather than `12`.
    stdout, io = _out("bc", b"1/*c*/2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0


def test_bc_a_block_comment_spanning_lines_advances_the_counter():
    # The comment's newlines count, but they do not end the statement.
    assert _out("bc", b"1+1/*\n*/+1\n")[0] == b"3\n"
    stdout, io = _out("bc", b"/*\nmulti\n*/@\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 3: illegal character: @\n"
    assert io.exit_code == 0
    # The illegal character sits on line 2 although its statement starts
    # on line 1, which is why the diagnostic maps an offset to a line.
    assert _stderr_text(_out(
        "bc",
        b"1+1/*\n*/ @\n")[1]) == ("(standard_in) 2: illegal character: @\n")


def test_bc_an_unterminated_block_comment_has_its_own_wording():
    # GNU reports this one with no input name and no line number, and
    # the statements it was still reading never run.
    stdout, io = _out("bc", b"1+1\n/* unterminated\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == "EOF encountered in a comment.\n"
    assert io.exit_code == 0


def test_bc_quit_ends_the_run_at_lex_time():
    assert _out("bc", b"quit\n")[0] == b""
    # Earlier lines have already printed; later ones are never read.
    assert _out("bc", b"1+1\nquit\n2+2\n")[0] == b"2\n"
    # Nothing after it on its own line is even scanned, so neither the
    # trailing expression nor the illegal character is reported.
    stdout, io = _out("bc", b"quit 1+1\n")
    assert stdout == b""
    assert _stderr_text(io) == ""
    stdout, io = _out("bc", b"quit@\n")
    assert stdout == b""
    assert _stderr_text(io) == ""
    assert io.exit_code == 0


def test_bc_a_line_a_quit_cuts_short_is_parsed_but_not_executed():
    # GNU compiles a line and runs it at its newline, and `quit` exits
    # before that newline arrives, so `1+1` never prints and `1/0` never
    # divides -- but a syntax error on the same line is still reported.
    assert _out("bc", b"1+1;quit\n3+3\n")[0] == b""
    stdout, io = _out("bc", b"1/0;quit\n3+3\n")
    assert stdout == b""
    assert _stderr_text(io) == ""
    stdout, io = _out("bc", b"1 2;quit\n3+3\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0


def test_bc_quit_is_only_a_whole_word_and_never_inside_a_comment():
    assert _out("bc", b"quitx\n")[0] == b"0\n"
    assert _out("bc", b"1+1 #quit\n2+2\n")[0] == b"2\n4\n"
    assert _out("bc", b"/*quit*/1+1\n")[0] == b"2\n"


def test_bc_quit_anywhere_but_a_statement_start_is_also_a_syntax_error():
    # GNU hands `quit` to the parser, which refuses it mid-expression and
    # still ends the run, so nothing after it is evaluated either.
    stdout, io = _out("bc", b"1 quit\n2+2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0
    stdout, io = _out("bc", b"1+quit\n2+2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"


def test_bc_halt_is_a_runtime_statement_not_a_lexer_exit():
    assert _out("bc", b"halt\n")[0] == b""
    assert _out("bc", b"1+1\nhalt\n2+2\n")[0] == b"2\n"
    # The difference from `quit`: everything earlier on halt's own line
    # has already run and printed by the time halt is reached.
    assert _out("bc", b"1+1;halt;2+2\n")[0] == b"2\n"
    assert _out("bc", b"x=5;halt;x\n")[0] == b""
    # And nothing after it is read, so the illegal character never is.
    stdout, io = _out("bc", b"1+1\nhalt\n@\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == ""
    assert io.exit_code == 0


def test_bc_halt_with_anything_after_it_stays_a_syntax_error():
    # `halt` is a statement, so it is not an expression operand either.
    for text in (b"halt 1+1\n", b"1+halt\n", b"x=halt\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    assert _out("bc", b"haltx\n")[0] == b"0\n"


def test_bc_length_counts_significant_digits():
    assert _out("bc", b"length(0)\n")[0] == b"1\n"
    assert _out("bc", b"length(100)\n")[0] == b"3\n"
    assert _out("bc", b"length(-123)\n")[0] == b"3\n"
    assert _out("bc", b"length(1.23456)\n")[0] == b"6\n"
    assert _out("bc", b"length(1.230)\n")[0] == b"4\n"
    # The integer part's leading zeros do not count and the fraction's
    # do, so `0.5` is 1 digit and `0.05` is 2.
    assert _out("bc", b"length(0.5)\n")[0] == b"1\n"
    assert _out("bc", b"length(0.05)\n")[0] == b"2\n"
    assert _out("bc", b"length(007)\n")[0] == b"1\n"
    assert _out("bc", b"length(0.000)\n")[0] == b"3\n"
    assert _out("bc", b"length(2^100)\n")[0] == b"31\n"


def test_bc_scale_of_a_value_is_the_scale_it_carries():
    assert _out("bc", b"scale(0)\n")[0] == b"0\n"
    assert _out("bc", b"scale(1.230)\n")[0] == b"3\n"
    assert _out("bc", b"scale(1.23456)\n")[0] == b"5\n"
    # A literal is not reduced, so the global scale does not touch it.
    assert _out("bc", b"scale=2;scale(1.23456)\n")[0] == b"5\n"
    assert _out("bc", b"scale(2^100)\n")[0] == b"0\n"
    assert _out("bc", b"x=1.50;length(x);scale(x)\n")[0] == b"3\n2\n"


def test_bc_both_builtins_follow_the_global_scale_of_a_quotient():
    # At the default scale of 0, `1/3` is 0, so both answer for that.
    assert _out("bc", b"length(1/3)\n")[0] == b"1\n"
    assert _out("bc", b"scale(1/3)\n")[0] == b"0\n"
    assert _out("bc", b"scale=3;length(1/3);scale(1/3)\n")[0] == b"3\n3\n"
    # `-l` only moves the initial scale, which both builtins then see.
    assert _out("bc -l", b"length(1/3)\n")[0] == b"20\n"
    assert _out("bc -l", b"scale(1/3)\n")[0] == b"20\n"
    assert _out("bc -l", b"length(0)\n")[0] == b"1\n"
    assert _out("bc -l", b"scale(0)\n")[0] == b"0\n"


def test_bc_a_builtin_needs_its_argument_and_only_one():
    for text in (b"length()\n", b"scale()\n", b"length(1,2)\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    # `scale` stays a readable register when no `(` follows it.
    assert _out("bc", b"scale\n")[0] == b"0\n"
    assert _out("bc", b"length=2\n")[0] == b""
    assert _stderr_text(_out(
        "bc", b"length=2\n")[1]) == ("(standard_in) 1: syntax error\n")


def test_bc_a_builtin_without_its_paren_is_an_incomplete_construct():
    # A legal prefix, so GNU charges the failure to the next line -- the
    # same rule `sqrt` follows.
    for text in (b"length\n", b"sqrt\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 2: syntax error\n", text
        assert io.exit_code == 0, text


def test_bc_double_signs_are_one_token_each():
    # GNU's lexer reads `++` and `--` as single tokens, so `1++2` is a
    # syntax error rather than `1 + (+2)`.
    for text in (b"1++2\n", b"1--2\n", b"1+++2\n", b"1---2\n", b"1++\n",
                 b"5++2\n", b"5++\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    # A separated sign is not the doubled token, and `-` is the only
    # unary sign there is, so `1- -2` works where `1+ +2` does not.
    assert _out("bc", b"1- -2\n")[0] == b"3\n"
    assert _stderr_text(_out(
        "bc", b"1+ +2\n")[1]) == ("(standard_in) 1: syntax error\n")
    # A postfix step still binds to its name, so these keep working.
    assert _out("bc", b"x=5; x++ + 1\n")[0] == b"6\n"
    assert _out("bc", b"x=5;x+++1;x\n")[0] == b"6\n6\n"


def test_bc_there_is_no_unary_plus():
    for text in (b"+5\n", b"2-+3\n", b"(+5)\n", b"x=+5\n", b"++5\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    # Unary minus does exist, so these are the control rows.
    assert _out("bc", b"-5\n")[0] == b"-5\n"
    assert _out("bc", b"2+-3\n")[0] == b"-1\n"


def test_bc_a_bare_sign_charges_the_two_to_different_lines():
    # `+` cannot start an expression at all, so it is charged to its own
    # line; `-` is a legal prefix, so it is charged to the next one.
    assert _stderr_text(_out("bc",
                             b"+\n")[1]) == ("(standard_in) 1: syntax error\n")
    assert _stderr_text(_out("bc",
                             b"-\n")[1]) == ("(standard_in) 2: syntax error\n")


def test_bc_prefix_and_postfix_steps_on_an_undefined_name():
    assert _out("bc", b"++x\n")[0] == b"1\n"
    assert _out("bc", b"x++\n")[0] == b"0\n"
    assert _out("bc", b"--x\n")[0] == b"-1\n"
    assert _out("bc", b"x--\n")[0] == b"0\n"


# -- Section Z: a parse error discards the whole line ------------------
# GNU compiles one input line and runs it at its newline, so a statement
# that will not parse means none of that line ever ran. The parse
# diagnostics are the exception: GNU still reports one per bad statement.


def test_bc_a_parse_error_discards_the_whole_line():
    for text in (b"1 2;5+5\n", b"5+5;1 2\n", b"x=5;1 2;x\n",
                 b"scale=2;7/2;1 2\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    # Only the bad line is discarded; the next one still runs.
    stdout, io = _out("bc", b"1 2; 5+5\n9+9\n")
    assert stdout == b"18\n"
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    stdout, io = _out("bc", b"1+1;1 2\n2+2\n")
    assert stdout == b"4\n"
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"


def test_bc_each_bad_statement_on_a_line_still_reports():
    # The discard is about output, not diagnostics: two bad statements on
    # one line are two syntax errors, both charged to that line.
    stdout, io = _out("bc", b"1 2;3 4\n")
    assert stdout == b""
    assert _stderr_text(io) == ("(standard_in) 1: syntax error\n"
                                "(standard_in) 1: syntax error\n")
    assert io.exit_code == 0
    assert _stderr_text(_out(
        "bc", b"1 2;3 4;5 6\n")[1]) == ("(standard_in) 1: syntax error\n"
                                        "(standard_in) 1: syntax error\n"
                                        "(standard_in) 1: syntax error\n")


def test_bc_a_discarded_line_rolls_back_every_write():
    # None of the line ran, so neither did its assignments -- the symbol
    # table and all three registers go back to what they were.
    assert _out("bc", b"x=5;1 2\nx\n")[0] == b"0\n"
    assert _out("bc", b"x=5;x=6;1 2\nx\n")[0] == b"0\n"
    assert _out("bc", b"ibase=1;1 2\nibase\n")[0] == b"10\n"
    assert _out("bc", b"scale=3;1 2\nscale\n")[0] == b"0\n"
    assert _out("bc", b"obase=16;1 2\nobase;255\n")[0] == b"10\n255\n"
    assert _out("bc", b"1+1; last;1 2\nlast\n")[0] == b"0\n"
    assert _out("bc", b"x=5;@\nx\n")[0] == b"0\n"


def test_bc_a_discarded_line_suppresses_its_runtime_diagnostics():
    # The line never ran, so its divide by zero, its unknown function and
    # its clamped register never happened either.
    for text in (b"1/0;1 2\n", b"1 2;1/0\n", b"foo(1);1 2\n", b"1 2;foo(1)\n",
                 b"ibase=1;1 2\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text


def test_bc_a_runtime_error_alone_discards_nothing():
    # Only a *parse* failure discards. A runtime error is non-fatal, the
    # values already printed on its line stay printed, and the writes
    # already made stay made.
    stdout, io = _out("bc", b"2+2;1/0\n")
    assert stdout == b"4\n"
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0
    assert _out("bc", b"x=5;1/0\nx\n")[0] == b"5\n"
    assert _out("bc", b"ibase=1;1+1;ibase\n")[0] == b"2\n2\n"


def test_bc_the_discarded_unit_is_the_logical_line():
    # A block comment stretches one statement list over two input lines,
    # and the whole list is still one unit: the `1+1` is discarded by the
    # illegal character that sits on input line 2.
    stdout, io = _out("bc", b"1+1/*\n*/;@\nx\n")
    assert stdout == b"0\n"
    assert _stderr_text(io) == "(standard_in) 2: illegal character: @\n"
    assert io.exit_code == 0


def test_bc_a_halt_on_a_discarded_line_does_not_run():
    # GNU compiles the whole line before running any of it, so a halt on
    # a line that does not parse never happens and the run carries on.
    stdout, io = _out("bc", b"1+1;halt;1 2\n3+3\n")
    assert stdout == b"6\n"
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0
    assert _out("bc", b"1 2;halt\n3+3\n")[0] == b"6\n"
    assert _out("bc", b"halt;1 2\n3+3\n")[0] == b"6\n"
    # And a halt on a line that does parse still ends the run.
    assert _out("bc", b"1+1;halt;2+2\n3+3\n")[0] == b"2\n"


def test_bc_the_discard_does_not_disturb_quit():
    # A `quit` line is already never executed, so the only thing the
    # discard adds is that its parse errors are still reported.
    stdout, io = _out("bc", b"x=5;1 2;quit\nx\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0
    assert _out("bc", b"1+1;quit;1 2\n")[0] == b""
    assert _stderr_text(_out("bc", b"1+1;quit;1 2\n")[1]) == ""
    # An earlier line's output is still safe from both of them.
    assert _out("bc", b"1+1\n2+2\n1 2;x\n3+3\n")[0] == b"2\n4\n6\n"
    assert _out("bc", b"1+1\n2+2\nquit\n3+3\n")[0] == b"2\n4\n"


# -- Section Y: a runtime error is fatal WITHIN its line ---------------
# It stays non-fatal across lines, which is the older finding: the two
# rules are about different scopes, and only a parse error rolls back.


def test_bc_a_runtime_error_abandons_the_rest_of_its_line():
    stdout, io = _out("bc", b"1/0;2+2\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0
    # Non-fatal across lines, as before: the next line still runs.
    assert _out("bc", b"1/0;2+2\n3+3\n")[0] == b"6\n"
    # A statement before the error keeps its printed value.
    assert _out("bc", b"2+2;1/0\n")[0] == b"4\n"
    assert _out("bc", b"1+1;1/0;2+2\n")[0] == b"2\n"


def test_bc_a_runtime_error_stops_execution_without_rolling_back():
    # The decisive row: `x=5` stays written and `y=7` never runs, so a
    # runtime error is not the parse error's all-or-nothing rollback.
    assert _out("bc", b"x=5;1/0;y=7\nx\ny\n")[0] == b"5\n0\n"
    assert _out("bc", b"1/0;x=5\nx\n")[0] == b"0\n"
    assert _out("bc", b"ibase=16;1/0;FF\nibase\n")[0] == b"16\n"
    assert _out("bc", b"scale=3;1/0\nscale\n")[0] == b"3\n"


def test_bc_an_undefined_function_abandons_the_line_the_same_way():
    stdout, io = _out("bc", b"1+1;foo(1);2+2\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Function foo not defined.\n")
    assert io.exit_code == 0
    assert _out("bc", b"s(0);2+2\n")[0] == b""


def test_bc_a_runtime_warning_is_not_an_error_and_abandons_nothing():
    # `ibase=1` warns and carries on, where `1/0` stops the line.
    stdout, io = _out("bc", b"ibase=1;2+2\n")
    assert stdout == b"4\n"
    assert _stderr_text(io) == (
        "Runtime warning (func=(main), adr=3): ibase too small, set to 2\n")
    assert io.exit_code == 0
    assert _out("bc", b"ibase=1;1+1;ibase\n")[0] == b"2\n2\n"


def test_bc_a_runtime_error_stops_a_later_halt_on_its_line():
    # The halt never runs, so the run carries on to the next line.
    assert _out("bc", b"1/0;halt;2+2\n3+3\n")[0] == b"6\n"
    assert _out("bc", b"1+1;1/0;halt\n3+3\n")[0] == b"2\n6\n"
    # The other order: halt first, so the division never happens.
    stdout, io = _out("bc", b"halt;1/0\n3+3\n")
    assert stdout == b""
    assert _stderr_text(io) == ""
    # And a `quit` line never runs at all, error included.
    stdout, io = _out("bc", b"1/0;quit\n3+3\n")
    assert stdout == b""
    assert _stderr_text(io) == ""
    assert io.exit_code == 0


def test_bc_a_parse_error_still_outranks_a_runtime_one_on_its_line():
    stdout, io = _out("bc", b"1/0;1 2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    assert io.exit_code == 0
    assert _out("bc", b"1/0;3 4\n5+5\n")[0] == b"10\n"


# -- Section Y: an incomplete construct is charged to its terminator ---


def test_bc_an_incomplete_construct_followed_by_a_semicolon():
    # GNU's parser fails on whichever token arrives next. A `;` sits on
    # the current line, so the diagnostic does too -- where a newline has
    # already moved the counter on.
    for text in (b"(1+;x=5\n", b"1+;2\n", b"scale=;x\n", b"1+;\n", b"1+;;\n",
                 b"sqrt;1\n", b"length;1\n", b"-;1\n", b"1+ ;2\n",
                 b"x=5;1+;y=6\n", b"(1+2;3\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text
    # The line is discarded too, so the assignment before it is undone.
    assert _out("bc", b"(1+;x=5\nx\n")[0] == b"0\n"


def test_bc_the_last_statement_of_a_line_is_still_charged_to_the_next():
    # The control rows: nothing follows, so the newline is the token that
    # fails and it has already moved the counter on.
    for text in (b"x=5;(1+\n", b"1+\n", b"scale=\n", b"(1+2\n", b"x=5;-\n",
                 b"-\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 2: syntax error\n", text
        assert io.exit_code == 0, text


def test_bc_the_terminating_semicolon_carries_its_own_line():
    # A block comment moves the `;` onto input line 2, and the diagnostic
    # follows it there rather than staying with the statement's start.
    stdout, io = _out("bc", b"1+/*\n*/;2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"
    assert io.exit_code == 0
    # An illegal character after such a `;` is still reported by itself,
    # and both diagnostics land on line 1.
    stdout, io = _out("bc", b"1+;@\n")
    assert stdout == b""
    assert _stderr_text(io) == ("(standard_in) 1: syntax error\n"
                                "(standard_in) 1: illegal character: @\n")
    assert io.exit_code == 0


# -- `print` and string statements --------------------------------------
#
# Measured against GNU bc 1.07.1 in docker (`debian:stable-slim`).


def test_bc_print_writes_no_newline():
    # The whole point of `print`: an expression statement ends its line
    # and `print` does not, so the next write continues it.
    assert _out("bc", b'print "hi"\n')[0] == b"hi"
    assert _out("bc", b"print 5\n6\n")[0] == b"56\n"


def test_bc_print_takes_a_comma_separated_list():
    assert _out("bc", b'print "a=", 1+1, "\\n"\n')[0] == b"a=2\n"
    assert _out("bc", b'print "a", "b"\n')[0] == b"ab"
    assert _out("bc", b'print (1+2)*3, "\\n"\n')[0] == b"9\n"


def test_bc_each_element_is_written_where_it_is_reached():
    # GNU writes a value where its own instruction runs, not at the end
    # of the statement, so an element sees everything the elements before
    # it changed and nothing a later one will: `print 5, last` writes the
    # 5 twice, and `print 255, obase=16` writes the 255 in base ten and
    # then the 16 in the base it just set.
    assert _out("bc", b"print 5, last\n")[0] == b"55"
    assert _out("bc", b"print last, 5\n")[0] == b"05"
    assert _out("bc", b"print 1, last, last\n")[0] == b"111"
    assert _out("bc", b"print 255, obase=16\n")[0] == b"25510"
    assert _out("bc", b"print obase=16, 255\n")[0] == b"10FF"
    assert _out("bc", b"print 255, obase=16, 255\n")[0] == b"25510FF"
    assert _out("bc", b"x=1\nprint x, x=9, x\n")[0] == b"199"
    assert _out("bc", b"scale=3\nprint 1/3, scale=1, 1/3\n")[0] == b".3331.3"


def test_bc_an_expression_statement_renders_where_it_is_reached_too():
    # The same rule outside `print`: the 255 is written before the `;`
    # changes the base, so only the second one comes out hexadecimal.
    assert _out("bc", b"255; obase=16\n")[0] == b"255\n"
    assert _out("bc", b"obase=16; 255\n")[0] == b"FF\n"
    assert _out("bc", b"255; obase=16; 255\n")[0] == b"255\nFF\n"


def test_bc_last_follows_its_line_being_discarded():
    # `last` is state, so a syntax error later on the line rolls it back
    # with everything else the line wrote.
    assert _out("bc", b"print 5\nlast\n")[0] == b"55\n"
    stdout, io = _out("bc", b"print 5; 1 2\nlast\n")
    assert stdout == b"0\n"
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    # A runtime error does not roll it back: the element before it stands.
    assert _out("bc", b"print 5, 1/0\nlast\n")[0] == b"55\n"


def test_bc_print_sets_last_where_a_string_does_not():
    # A printed value reaches `last`, so `print 5; .` answers 5 twice;
    # a string never does, so `last` still holds the 2.
    assert _out("bc", b"print 5; .\n")[0] == b"55\n"
    assert _out("bc", b"print 5; last\n")[0] == b"55\n"
    assert _out("bc", b'1+1; print "x"; last\n')[0] == b"2\nx2\n"
    # The last value of a list wins.
    assert _out("bc", b"print 5, 6; last\n")[0] == b"566\n"


def test_bc_print_element_is_a_whole_expression():
    # Assignment is part of the expression grammar, so it prints here
    # where the statement `x=5` prints nothing.
    assert _out("bc", b"print x=5\nx\n")[0] == b"55\n"
    assert _out("bc", b"print (x=5); x\n")[0] == b"55\n"
    assert _out("bc", b"x=1; print x++, x, \"\\n\"\n")[0] == b"12\n"
    assert _out("bc", b'print sqrt(4), "\\n"\n')[0] == b"2\n"
    assert _out("bc", b'obase=16\nprint 255, "\\n"\n')[0] == b"FF\n"


def test_bc_print_expands_the_escapes_gnu_has_a_rule_for():
    # `\a \b \f \n \q \r \t \\`, and `\q` is the double quote.
    assert _out("bc", b'print "A\\aB\\bC\\fD\\nE\\qF\\rG\\tH\\\\I"\n')[0] == (
        b'A\x07B\x08C\x0cD\nE"F\rG\tH\\I')


def test_bc_print_writes_nothing_for_an_escape_it_has_no_rule_for():
    # Both characters vanish, digits and a trailing backslash included.
    for text in (b'print "x\\zy"\n', b'print "a\\0b\\1c"\n',
                 b'print "a\\eb\\vc"\n', b'print "a\\Nb\\Tc"\n'):
        assert _out("bc", text)[0] in (b"xy", b"abc"), text
    assert _out("bc", b'print "ab\\\\"\n')[0] == b"ab\\"
    # A lone backslash before the closing quote: the quote still closes
    # the token, and the backslash writes nothing.
    assert _out("bc", b'print "ab\\"\n')[0] == b"ab"


def test_bc_a_bare_string_is_a_statement_written_raw():
    assert _out("bc", b'"raw"\n')[0] == b"raw"
    assert _out("bc", b'"a"; 1+1\n')[0] == b"a2\n"
    assert _out("bc", b'"a";"b"\n')[0] == b"ab"
    assert _out("bc", b'""\n')[0] == b""
    # No escape expansion: `print` alone does that.
    assert _out("bc", b'"A\\nB\\tC\\zD"\n')[0] == b"A\\nB\\tC\\zD"


def test_bc_a_string_is_never_an_expression():
    for text in (b'1+"a"\n', b'"a"1\n', b'print "a" "b"\n', b'print "a" 1\n',
                 b'print , "a"\n'):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
        assert io.exit_code == 0, text


def test_bc_print_stays_a_reserved_word():
    for text in (b"print=1\n", b"1+print\n"):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(io) == "(standard_in) 1: syntax error\n", text
    # Only a whole identifier is the keyword.
    assert _out("bc", b"printx=5\nprintx\n")[0] == b"5\n"
    # And no space is needed after it.
    assert _out("bc", b'print"a"\n')[0] == b"a"


def test_bc_print_with_no_element_is_charged_to_the_next_line():
    # A legal prefix that ran out of input, so GNU charges the newline's
    # line rather than the keyword's, and the next line still runs.
    stdout, io = _out("bc", b"print\n1+1\n")
    assert stdout == b"2\n"
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"
    # A trailing comma is the same shape.
    stdout, io = _out("bc", b'print "a",\n')
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"
    # A second element with nothing between them is not: `2` is the token
    # that fails, and it sits on its own line.
    stdout, io = _out("bc", b"print 1 2\n")
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"


def test_bc_a_string_hides_a_separator_and_a_comment():
    # `;`, `#` and `/*` are content inside a string, not syntax.
    assert _out("bc", b'print "a;b", "\\n"\n')[0] == b"a;b\n"
    assert _out("bc", b'print "a#b", "\\n"\n')[0] == b"a#b\n"
    assert _out("bc", b'print "a/*b*/c", "\\n"\n')[0] == b"a/*b*/c\n"
    # A `quit` in one does not end the run either.
    assert _out("bc", b'print "quit"; print "after"\n')[0] == b"quitafter"
    # A comment outside one still eats the string behind it.
    assert _out("bc", b'print "a" # "b"\nprint "c"\n')[0] == b"ac"


def test_bc_a_string_runs_to_the_next_quote_across_lines():
    # The token has no line limit, so the statement stays open and the
    # line counter still advances: the `1 2` below is on line 3.
    assert _out("bc", b'print "a\nb"\n')[0] == b"a\nb"
    stdout, io = _out("bc", b'print "a\nb"\n1 2\n')
    assert stdout == b"a\nb"
    assert _stderr_text(io) == "(standard_in) 3: syntax error\n"
    # A `#` or a `/*` on the string's later line is content too.
    assert _out("bc", b'print "a\nb # c"\nprint "d"\n')[0] == b"a\nb # cd"
    assert _out("bc", b'print "a\n/*x*/b"\nprint "d"\n')[0] == b"a\n/*x*/bd"
    assert _out("bc", b'print "a\nquit b"\nprint "c"\n')[0] == b"a\nquit bc"


def test_bc_an_unclosed_quote_is_an_illegal_character():
    # GNU's lexer has no rule a lone `"` matches, so it is reported the
    # way `@` is and scanning resumes right after it -- the next line
    # runs, comments included.
    for text in (b'"abc\n', b'print "abc\n', b'1+"abc\n'):
        stdout, io = _out("bc", text)
        assert stdout == b"", text
        assert _stderr_text(
            io) == '(standard_in) 1: illegal character: "\n', text
        assert io.exit_code == 0, text
    stdout, io = _out("bc", b'"abc\n1+1\n')
    assert stdout == b"2\n"
    assert _stderr_text(io) == '(standard_in) 1: illegal character: "\n'
    # The `;` behind it still separates, so the `1 2` is its own bad
    # statement and reports separately.
    stdout, io = _out("bc", b'"abc; 1 2\n')
    assert stdout == b""
    assert _stderr_text(io) == ('(standard_in) 1: illegal character: "\n'
                                "(standard_in) 1: syntax error\n")
    # Two quotes on different lines are one token, so nothing is illegal:
    # the `def` after it is simply a name in the wrong place.
    stdout, io = _out("bc", b'"abc\n"def\n')
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 2: syntax error\n"


def test_bc_a_syntax_error_discards_what_its_line_printed():
    # GNU compiles a whole line before running any of it, so a later
    # statement's refusal undoes an earlier one's `print`.
    stdout, io = _out("bc", b'print "x"; 1 2\n')
    assert stdout == b""
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"


def test_bc_a_runtime_error_keeps_what_the_statement_already_wrote():
    # A runtime error is not a parse error: everything written before it
    # stays, the rest of the line is abandoned, and the next line runs.
    stdout, io = _out("bc", b'print "a", 1/0, "z"\n')
    assert stdout == b"a"
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert _out("bc", b'print "x", 1/0\n2+2\n')[0] == b"x4\n"


def test_bc_halt_and_quit_still_bound_a_printing_line():
    # `halt` acts where it is reached, so the `print` before it stands.
    assert _out("bc", b'print "a"; halt; print "b"\n')[0] == b"a"
    assert _out("bc", b'"a"; halt; "b"\n')[0] == b"a"
    # `quit` is read by the lexer, so its whole line never runs at all.
    assert _out("bc", b'print "a"; quit\nprint "b"\n')[0] == b""


# -- The output column, once `print` can leave a line open --------------


def test_bc_the_fold_column_carries_across_a_print():
    # The column is one counter for the whole run, so a `print` that left
    # the line two characters in folds the value that follows two
    # characters early: 66 digits here rather than 68.
    digits = UNFOLDED_300.rstrip(b"\n")
    assert _out("bc",
                b'print "ab"; 2^300\n')[0] == (b"ab" + digits[:66] + b"\\\n" +
                                               digits[66:] + b"\n")
    # And a `print`ed value leaves the column where it ended, so the next
    # statement's value continues the same line.
    assert _out("bc", b"print 2^300; 1+1\n")[0] == (digits[:68] + b"\\\n" +
                                                    digits[68:] + b"2\n")


def test_bc_a_printed_string_folds_and_counts_like_a_value():
    assert _out("bc", b'print "' + b"x" * 100 +
                b'"\n')[0] == (b"x" * 68 + b"\\\n" + b"x" * 32)
    # A bare string counts too.
    assert _out("bc", b'"' + b"x" * 100 + b'"\n')[0] == (b"x" * 68 + b"\\\n" +
                                                         b"x" * 32)
    # Two statements share the counter: 60 then 20 folds inside the 20.
    assert _out("bc", b'print "' + b"x" * 60 + b'"; print "' + b"y" * 20 +
                b'"\n')[0] == (b"x" * 60 + b"y" * 8 + b"\\\n" + b"y" * 12)
    # Across input lines as well.
    assert _out("bc", b'print "' + b"x" * 60 + b'"\nprint "' + b"y" * 20 +
                b'"\n')[0] == (b"x" * 60 + b"y" * 8 + b"\\\n" + b"y" * 12)


def test_bc_a_newline_anywhere_starts_the_column_over():
    assert _out("bc", b'print "' + b"x" * 60 + b'\\n"; print "' + b"y" * 20 +
                b'"\n')[0] == (b"x" * 60 + b"\n" + b"y" * 20)
    # An expanded escape is one column, not its source width: 66 x's, a
    # tab and a `y` fill the line, so the second `y` folds.
    assert _out("bc", b'print "' + b"x" * 66 + b'\\tyy"\n')[0] == (b"x" * 66 +
                                                                   b"\ty\\\ny")


def test_bc_a_discarded_line_rolls_the_column_back():
    # The line never ran, so its `print` never moved the counter and the
    # 20 characters after it do not fold.
    stdout, io = _out(
        "bc", b'print "' + b"x" * 60 + b'"; 1 2\nprint "' + b"y" * 20 + b'"\n')
    assert stdout == b"y" * 20
    assert _stderr_text(io) == "(standard_in) 1: syntax error\n"
    # A runtime error does not roll it back: the 60 characters stand.
    stdout, io = _out(
        "bc", b'print "' + b"x" * 60 + b'", 1/0\nprint "' + b"y" * 20 + b'"\n')
    assert stdout == b"x" * 60 + b"y" * 8 + b"\\\n" + b"y" * 12


def test_bc_line_length_bounds_a_printed_string_too():
    assert _out("BC_LINE_LENGTH=10 bc",
                b'print "abcdefghijklmno"\n')[0] == b"abcdefgh\\\nijklmno"
    assert _out("BC_LINE_LENGTH=3 bc",
                b'print "abcdef"\n')[0] == b"a\\\nb\\\nc\\\nd\\\ne\\\nf"
    assert _out("BC_LINE_LENGTH=0 bc",
                b'print "' + b"x" * 100 + b'"\n')[0] == b"x" * 100


def test_bc_the_issue_1156_program():
    # The report's own heredoc. GNU prints `a=50.204700469970704`; the
    # last digits differ because bc's values are float64 here, which is
    # the separate gap tracked in #1119.
    program = (b"scale=15\n"
               b"a=7*7.172100067138672\n"
               b'print "a="; a; print "\\n"\n')
    assert _out("bc -l", program)[0] == b"a=50.204700469970700\n\n"


def test_bc_the_fold_column_counts_utf8_bytes():
    # GNU counts the bytes it writes, not the characters, so a four-byte
    # character fills the 68-column line seventeen at a time.
    globe = "\N{EARTH GLOBE EUROPE-AFRICA}"
    assert _out(
        "bc",
        f'print "{globe * 80}"\n'.encode())[0] == ((globe * 17 + "\\\n") * 4 +
                                                   globe * 12).encode()
    # A two-byte one moves it two: 66 x's and one `é` fill the line.
    assert _out("bc", f'print "{"x" * 66}éé"\n'.encode())[0] == ("x" * 66 +
                                                                 "é" + "\\\n" +
                                                                 "é").encode()
    # Where GNU would split a character across the fold it is moved whole
    # instead, so the output stays UTF-8: 67 x's leave one column and the
    # `é` needs two.
    assert _out("bc",
                f'print "{"x" * 67}éé"\n'.encode())[0] == ("x" * 67 + "\\\n" +
                                                           "éé").encode()

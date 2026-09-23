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

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# Grammar, ported from `bc.ts` so the two hosts parse one language
# (precedence low to high):
#   statement := 'halt' | string | 'print' print_list | assign | expr
#   print_list:= element { ',' element }
#   element   := string | expr
#   expr      := assign | additive
#   assign    := target ('='|'+='|'-='|'*='|'/='|'%='|'^=') expr
#   additive  := term   { (+|-) term }
#   term      := unary  { (*|/|%) unary }
#   unary     := (++|--) target | '-' unary | power
#   power     := atom ^ unary | atom
#   atom      := number | '(' expr ')' | register | name ('++'|'--')?
#               | builtin '(' expr ')' | func '(' expr ')'
#   target    := name | 'scale' | 'ibase' | 'obase' | 'last' | '.'
#   builtin   := sqrt | length | scale
#   func      := s | c | a | l | e   (all need -l)
#   string    := '"' [^"]* '"'
# A statement's output is rendered as it is reached rather than at the
# end, because `obase`, `scale` and `last` can all change partway down a
# `print` list: `print 255, obase=16` writes `255` and then `10`.
# A string is a statement and never an expression, so `1+"a"` is a syntax
# error, and its token runs to the next `"` anywhere in the input --
# across newlines, and past a `;`, a `#` or a `/*` -- because a backslash
# never escapes the closing quote. A `"` the input never closes is not a
# token at all: GNU's lexer has no rule it matches, so the quote is
# reported as an illegal character and scanning resumes right after it.
# There is no unary `+`: GNU's lexer has no such operator, so `+5` and
# `1+ +2` are both syntax errors, and `++`/`--` are single tokens, which
# is what makes `1++2` one too rather than `1 + (+2)`.

# `-l` loads the math library, which sets scale to 20. Without it bc's
# scale is 0, which is why plain `7/2` is 3 and `bc -l` answers 3.50...
MATH_LIBRARY_SCALE = 20

# The largest scale either host can render. JavaScript's
# `Number.prototype.toFixed` refuses a fractionDigits above 100, so a
# larger scale could not be printed identically by the TypeScript twin;
# it also bounds what a typed `scale=` can make this allocate. GNU bc
# accepts more, which is a documented divergence.
MAX_SCALE = 100

DEFAULT_BASE = 10
MIN_BASE = 2
# GNU refuses an `ibase` above 16 and an `obase` above 999 with a
# `too large` warning whose wording is not measured, so both hosts clamp
# silently instead of inventing one. The `obase` ceiling also keeps the
# digit-group width below the point where the two hosts spell the base
# differently (JavaScript switches to exponential notation at 1e21).
MAX_IBASE = 16
MAX_OBASE = 999
# Up to base 16 a digit is one character; above it GNU prints each digit
# as a space-separated decimal group instead.
MAX_CHAR_BASE = 16

# The magnitudes where both hosts spell a float in plain notation with
# the shortest digits that read back as it: python's `repr` turns
# exponential outside 1e-4..1e16 and JavaScript's `String` outside
# 1e-6..1e21, so this is the window they agree on, and outside it the
# exact expansion is used in both.
PLAIN_MIN = 1e-4
PLAIN_MAX = 1e16

# `^` and the math library are computed here, from IEEE multiplications
# and series, rather than through each host's libm, because the two
# libms do not agree: glibc's `pow` and V8's `**` answered `7.8041^15`
# as 24257295885134.4570 and 24257295885134.4530, and `math.cos(.1)`
# and `Math.cos(.1)` differ in the last bit too. The renderer prints the
# shortest digits that read back as the double, so one ulp reaches
# stdout. Everything below uses only `+ - * /` and `sqrt`, which
# IEEE-754 requires to be correctly rounded and both hosts therefore
# answer identically, in one fixed order.
#
# ln 2 and pi/2 are each split so the reduction's `k * <HI>` product is
# exact -- both HI constants carry 33 significant bits -- with the LO
# half holding the rest, which is Cody and Waite's reduction.
LN2_HI = 0.6931471803691238
LN2_LO = 1.9082149292705877e-10
LOG2E = 1.4426950408889634
PIO2_HI = 1.5707963267341256
PIO2_LO = 6.077100506506192e-11
TWO_OVER_PI = 0.6366197723675814
PI_2 = 1.5707963267948966

# Where `e(x)` saturates: exp(710) is past float64's largest value and
# exp(-746) below its smallest subnormal, so the reduction is only
# entered for an argument that can still produce a number.
EXP_MAX = 710.0
EXP_MIN = -746.0

# Series lengths. Each is the term count that carries its own reduced
# argument past float64's last bit, and the terms are summed
# smallest-first, so one surplus term costs a multiply and changes
# nothing while one term short would be visible.
EXP_TERMS = 15
SIN_TERMS = 10
ATAN_TERMS = 14
ATANH_TERMS = 18

# `l` reduces by repeated square roots until its argument is inside
# (0.5, 2), which is GNU's own libmath.b bracket. A tighter one is
# worse, not better: the answer is `2^k * atanh((x-1)/(x+1))`, so the
# relative error of that last atanh is divided by its own value, and a
# bracket nearer 1 makes the value smaller.
LOG_HI = 2.0
LOG_LO = 0.5
# `a` halves through `x/(1+sqrt(1+x*x))` until its argument is this
# small, which is at most two halvings for an argument in (0, 1].
ATAN_HI = 0.25
# `2^1024` is already an infinity, so a scaling exponent past this is
# applied in chunks.
POW2_CHUNK = 1000

# GNU writes a printed value one character at a time and breaks the
# output with a backslash and a newline when the column reaches
# `line_size`, so a folded line carries `line_size - 2` characters of
# the value plus the backslash. The width is settable through
# `BC_LINE_LENGTH`, where 0 means no folding at all; a value below
# `MIN_LINE_LENGTH` (but not 0) falls back to the default, since one
# character per line and a backslash leaves no room for the value.
LINE_LENGTH_VAR = "BC_LINE_LENGTH"
DEFAULT_LINE_LENGTH = 70
MIN_LINE_LENGTH = 3
# What C's `isspace` skips, which is not python's `str.strip` set.
C_BLANKS = " \t\n\v\f\r"
# `atoi` is `strtol` saturated to a signed 64-bit range and then
# truncated to an `int`, and both halves are observable:
# `BC_LINE_LENGTH=4294967296` disables folding because that truncates to
# 0, while `9223372036854775808` saturates and then truncates to -1,
# which falls back to the default.
C_LONG_BITS = 64
C_INT_BITS = 32

# GNU renders a non-fatal runtime error or warning with the bytecode
# address it happened at. The address depends on everything parsed before
# it, so it is not derivable here; 3 is what GNU emits for a bare `1/0`
# as the first statement, which is the measured case, and both hosts use
# the same constant so parity holds for the rest.
RUNTIME_ERROR_ADDR = 3

DIVIDE_BY_ZERO = "Divide by zero"
MODULO_BY_ZERO = "Modulo by zero"
# `0^-1` is reported with a lowercase reason where `1/0` is capitalised:
# GNU raises the two from different places and never spelled them the
# same way. Measured on bc 1.07.1, both as `Runtime error`.
POW_DIVIDE_BY_ZERO = "divide by zero"
IBASE_TOO_SMALL = "ibase too small, set to 2"
OBASE_TOO_SMALL = "obase too small, set to 2"
NEGATIVE_SCALE = "negative scale, set to 0"
NEGATIVE_SQRT = "Square root of a negative number"
# `^` takes an integer exponent, and GNU warns whenever the value it
# truncates carries a scale at all -- `2^1.0` warns although its value
# is whole -- and then uses the truncated exponent.
NONZERO_EXPONENT_SCALE = "non-zero scale in exponent"

# GNU names the input in a parse diagnostic; reading stdin it is the
# literal `(standard_in)`, and there is no `bc:` prefix anywhere.
INPUT_NAME = "(standard_in)"
SYNTAX_ERROR = "syntax error"
ILLEGAL_CHARACTER = "illegal character"
# A block comment that runs to the end of the input. GNU reports it with
# no input name and no line number, unlike every other diagnostic.
EOF_IN_COMMENT = "EOF encountered in a comment."


class BcParseError(Exception):
    """Text bc cannot parse; reported, then evaluation continues.

    GNU charges an *unexpected token* to its own line and an *incomplete
    construct* to the line after its last token, because a legal prefix
    only fails once the next line arrives.

    Args:
        text (str): the diagnostic body, e.g. `syntax error`.
        incomplete (bool): whether the parser ran out of input rather
            than meeting a token it could not use.
        pos (int): the offset in the statement the diagnostic belongs to,
            or -1 for the statement's first character. A block comment
            spanning lines puts later characters of one statement on a
            later input line, so the offset is what names the line.
    """

    def __init__(self,
                 text: str,
                 incomplete: bool = False,
                 pos: int = -1) -> None:
        super().__init__(text)
        self.text = text
        self.incomplete = incomplete
        self.pos = pos


class BcRuntimeError(Exception):
    """A non-fatal runtime error: reported, then evaluation continues."""


class BcHalt(Exception):
    """`halt` was reached: stop the run, keeping what already printed.

    It is a statement, so it acts when the statement runs, which is what
    tells it apart from `quit`: everything earlier on its line has
    already printed by then.
    """


@dataclass(frozen=True, slots=True)
class BcNumber:
    """A bc value and the number of fractional digits it prints with.

    bc tracks a scale per value, not just globally, which is the whole
    reason `0.1+0.2` prints `.3` at the default scale of 0: addition
    keeps the wider of its operands' scales, while division adopts the
    global one.

    Args:
        value (float): the numeric value.
        scale (int): fractional digits this value renders with.
    """

    value: float
    scale: int


ZERO = BcNumber(0.0, 0)


@dataclass(slots=True)
class BcState:
    """What survives between statements on one bc run.

    Args:
        scale (int): the global `scale` register.
        math_mode (bool): whether `-l` loaded the math library.
        ibase (int): the base numeric literals are read in.
        obase (int): the base results are printed in.
        last (BcNumber): the `last` register, also spelled `.`, holding
            the value of the most recently printed statement.
        variables (dict[str, BcNumber]): the symbol table. The whole
            BcNumber is stored, so a variable carries its own scale.
        warnings (list[str]): runtime warnings raised by the statement
            being evaluated, drained by the caller after each one.
    """

    scale: int
    math_mode: bool
    ibase: int = DEFAULT_BASE
    obase: int = DEFAULT_BASE
    last: BcNumber = ZERO
    variables: dict[str, BcNumber] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class BcStatement:
    """One bc statement and where its characters came from.

    Args:
        text (str): the statement source, comments already removed.
        lines (tuple[int, ...]): the input line each character of `text`
            sits on. A block comment spanning lines advances the counter
            without ending the statement, so one statement's characters
            can sit on more than one line.
        incomplete_line (int): the line GNU charges an incomplete
            construct to. Its parser fails on whichever token arrives
            next, so that is the `;` ending this statement when one
            does -- `1+;2` reports line 1 -- and otherwise the newline
            after it, which has already moved the counter on, so the
            last statement of a line reports the line after it.
        execute (bool): whether the statement runs. It is False for one
            on a line a `quit` cut short: GNU exits inside the lexer, so
            that line is parsed -- and a parse error still reported --
            but never executed.
    """

    text: str
    lines: tuple[int, ...]
    incomplete_line: int
    execute: bool


def clamp_scale(scale: int) -> int:
    """Hold a scale inside the range both hosts can render.

    Args:
        scale (int): the requested scale.

    Returns:
        int: the scale, clamped to 0..MAX_SCALE.
    """
    return max(0, min(scale, MAX_SCALE))


def truncate_int(value: float) -> int:
    """The integer bc reads a register or an exponent as.

    Args:
        value (float): the value to truncate toward zero.

    Returns:
        int: the truncated value, or 0 when it is not finite -- neither
            host can truncate an infinity or a NaN to an integer, and
            answering 0 in both is what keeps them in step.
    """
    if not math.isfinite(value):
        return 0
    return int(math.trunc(value))


def bc_sqrt(x: float) -> float:
    """Square root, refusing a negative argument as GNU does.

    Args:
        x (float): the argument.

    Returns:
        float: the square root. IEEE-754 requires a correctly rounded
            square root, so this is the one library call both hosts
            already agreed on bit for bit and the only one not rebuilt
            from a series here.

    Raises:
        BcRuntimeError: the argument is negative, which GNU reports
            rather than answering a NaN.
    """
    if x < 0:
        raise BcRuntimeError(NEGATIVE_SQRT)
    return math.sqrt(x)


def float_pow(base: float, exponent: int) -> float:
    """`base` raised to an integer power, by repeated squaring.

    Computed here rather than through the host's own power operator
    because glibc's `pow` and V8's `**` disagree by one ulp on ordinary
    input, which the renderer then prints. Repeated squaring is also the
    order GNU's own `bc_raise` multiplies in. The exponent is halved
    with `% 2` and `//` rather than with bit operators, because
    JavaScript's bit operators truncate to 32 bits and an exponent past
    that would then mean something different in the two hosts.

    Args:
        base (float): the base.
        exponent (int): the exponent, already truncated to an integer.

    Returns:
        float: the power, saturating to a signed infinity on overflow
            and to zero on underflow, as the multiplications do on their
            own.

    Raises:
        BcRuntimeError: zero raised to a negative power, which GNU
            reports as a lowercase `divide by zero`.
    """
    if base == 0 and exponent < 0:
        raise BcRuntimeError(POW_DIVIDE_BY_ZERO)
    remaining = -exponent if exponent < 0 else exponent
    result = 1.0
    square = base
    while remaining > 0:
        if remaining % 2 == 1:
            result *= square
        remaining //= 2
        if remaining > 0:
            square *= square
    if exponent >= 0:
        return result
    if result == 0.0:
        # `1/0.0` raises in python where JavaScript answers a signed
        # Infinity, which is what an underflowed power has to render as.
        return math.copysign(math.inf, result)
    return 1.0 / result


def scale_pow2(value: float, exponent: int) -> float:
    """Multiply by a power of two, in chunks so nothing overflows first.

    `e(x)` reduces to `r + k*ln2` and then scales by `2^k`, and `k` runs
    past float64's largest power of two at both ends: `e(709.7)` is
    finite while `2^1024` is not, so the scaling cannot be one multiply.

    Args:
        value (float): the value to scale.
        exponent (int): the power of two to multiply by.

    Returns:
        float: `value * 2**exponent`.
    """
    scaled = value
    remaining = exponent
    while remaining > POW2_CHUNK:
        scaled *= float_pow(2.0, POW2_CHUNK)
        remaining -= POW2_CHUNK
    while remaining < -POW2_CHUNK:
        scaled *= float_pow(2.0, -POW2_CHUNK)
        remaining += POW2_CHUNK
    return scaled * float_pow(2.0, remaining)


def bc_exp(x: float) -> float:
    """`e^x`, from the Taylor series after a `k*ln2` reduction.

    Args:
        x (float): the exponent.

    Returns:
        float: the exponential, inf past float64's range and 0 below it.
    """
    if math.isnan(x):
        return math.nan
    if x > EXP_MAX:
        return math.inf
    if x < EXP_MIN:
        return 0.0
    halves = math.floor(x * LOG2E + 0.5)
    rest = (x - halves * LN2_HI) - halves * LN2_LO
    total = 1.0
    for term in range(EXP_TERMS, 0, -1):
        total = 1.0 + rest * total / term
    return scale_pow2(total, halves)


def atanh_series(z: float) -> float:
    """`atanh(z)` for a `z` the log reduction has made small.

    Args:
        z (float): the argument, no larger than a third in magnitude.

    Returns:
        float: the inverse hyperbolic tangent.
    """
    square = z * z
    total = 0.0
    for term in range(ATANH_TERMS, 0, -1):
        total = 1.0 / (2 * term + 1) + square * total
    return z * (1.0 + square * total)


def bc_log(x: float) -> float:
    """Natural log, as `2^k * atanh((x-1)/(x+1))`.

    The argument is brought inside (0.5, 2) by repeated square roots,
    each of which halves the log it is taking, which is the reduction
    GNU's libmath.b uses. A non-positive argument never reaches here:
    GNU answers it from `scale` alone, which `log_domain_value` does.

    Args:
        x (float): the argument, strictly positive.

    Returns:
        float: the natural log, or the argument itself when that is an
            infinity or a NaN -- the square-root reduction would never
            leave the bracket for either, and both hosts' libm answered
            `log(inf)` as inf.
    """
    if not math.isfinite(x):
        return x
    doublings = 2.0
    reduced = x
    while reduced >= LOG_HI:
        doublings += doublings
        reduced = math.sqrt(reduced)
    while reduced <= LOG_LO:
        doublings += doublings
        reduced = math.sqrt(reduced)
    return doublings * atanh_series((reduced - 1.0) / (reduced + 1.0))


def log_domain_value(scale: int) -> float:
    """What GNU's `l(x)` answers for an argument at or below zero.

    libmath.b returns `(1 - 10^scale)/1` rather than refusing, so
    `scale=5; l(0)` is `-99999.00000`. float64 carries that exactly up
    to a scale of 15 and rounds it above, where GNU stays exact.

    Args:
        scale (int): the global scale register.

    Returns:
        float: one less than ten to the scale, negated.
    """
    return 1.0 - float(10**scale)


def sin_series(r: float) -> float:
    """`sin(r)` for an `r` the quadrant reduction has made small.

    Args:
        r (float): the argument, no larger than pi/4 in magnitude.

    Returns:
        float: the sine.
    """
    square = r * r
    total = 1.0
    for term in range(SIN_TERMS, 0, -1):
        total = 1.0 - square * total / ((2 * term) * (2 * term + 1))
    return r * total


def cos_series(r: float) -> float:
    """`cos(r)` for an `r` the quadrant reduction has made small.

    Args:
        r (float): the argument, no larger than pi/4 in magnitude.

    Returns:
        float: the cosine.
    """
    square = r * r
    total = 1.0
    for term in range(SIN_TERMS, 0, -1):
        total = 1.0 - square * total / ((2 * term - 1) * (2 * term))
    return total


def sin_quadrant(x: float, offset: int) -> float:
    """`sin(x + offset*pi/2)` for a non-negative `x`.

    One reduction serves both `s` and `c`, which is also how GNU's
    libmath.b spells the cosine -- `c(x)` is `s(x + pi/2)` there -- and
    is why the offset is a quarter turn rather than a second series.

    Args:
        x (float): the argument, not negative.
        offset (int): quarter turns to add, 0 for sine and 1 for cosine.

    Returns:
        float: the sine of the shifted argument, NaN for an argument
            that is not finite -- there is no quadrant to reduce one
            into, and NaN is what both hosts' libm answered.
    """
    if not math.isfinite(x):
        return math.nan
    quarters = math.floor(x * TWO_OVER_PI + 0.5)
    rest = (x - quarters * PIO2_HI) - quarters * PIO2_LO
    # Kept in float64 rather than reduced as an integer: an argument
    # past 2^53 makes `quarters` bigger than the integers float64 can
    # tell apart, and only the float sum is a fact both hosts share.
    quadrant = int(float(quarters + offset) % 4.0)
    if quadrant == 0:
        return sin_series(rest)
    if quadrant == 1:
        return cos_series(rest)
    if quadrant == 2:
        return -sin_series(rest)
    return -cos_series(rest)


def bc_sin(x: float) -> float:
    """`sin(x)`, odd about zero so the reduction only sees a magnitude.

    Args:
        x (float): the argument.

    Returns:
        float: the sine.
    """
    if x < 0:
        return -sin_quadrant(-x, 0)
    return sin_quadrant(x, 0)


def bc_cos(x: float) -> float:
    """`cos(x)`, even about zero.

    Args:
        x (float): the argument.

    Returns:
        float: the cosine.
    """
    return sin_quadrant(-x if x < 0 else x, 1)


def atan_series(x: float) -> float:
    """`atan(x)` for an `x` the halving has made small.

    Args:
        x (float): the argument, no larger than `ATAN_HI`.

    Returns:
        float: the arctangent.
    """
    square = x * x
    total = 0.0
    for term in range(ATAN_TERMS, 0, -1):
        total = 1.0 / (2 * term + 1) - square * total
    return x * (1.0 - square * total)


def bc_atan(x: float) -> float:
    """`atan(x)`, by reciprocal and half-angle reduction.

    An argument above one is reflected through `pi/2 - atan(1/x)` and
    what is left is halved by `x/(1+sqrt(1+x*x))` until the series
    converges in a handful of terms.

    Args:
        x (float): the argument.

    Returns:
        float: the arctangent. Only an infinity is answered up front; a
            NaN falls through the series, which carries it, which is
            what both hosts' libm answered for one.
    """
    magnitude = -x if x < 0 else x
    if math.isinf(magnitude):
        value = PI_2
    else:
        reflected = magnitude > 1.0
        reduced = 1.0 / magnitude if reflected else magnitude
        halvings = 0
        while reduced > ATAN_HI:
            reduced = reduced / (1.0 + math.sqrt(1.0 + reduced * reduced))
            halvings += 1
        value = float_pow(2.0, halvings) * atan_series(reduced)
        if reflected:
            value = PI_2 - value
    return -value if x < 0 else value


LOG_NAME = "l"

# The math library, whose members are reachable only under -l. `sqrt` is
# not one of them: GNU bc has it built in, so it answers without the
# flag, and it is dispatched separately below. A math-library name is
# only a function when a `(` follows it: the function and variable
# namespaces are separate, so `s=5; s; s(0)` reads the variable, the
# variable again, and then the sine.
MATH_FUNCS: dict[str, Callable[[float], float]] = {
    "s": bc_sin,
    "c": bc_cos,
    "a": bc_atan,
    LOG_NAME: bc_log,
    "e": bc_exp,
}

SQRT_NAME = "sqrt"
LENGTH_NAME = "length"
HALT_NAME = "halt"
QUIT_NAME = "quit"
PRINT_NAME = "print"
SCALE_NAME = "scale"
IBASE_NAME = "ibase"
OBASE_NAME = "obase"
LAST_NAME = "last"
# GNU spells the `last` register `.` as well, which is why a bare `.` is
# not part of a number.
LAST_ALIAS = "."

REGISTERS = frozenset(
    {SCALE_NAME, IBASE_NAME, OBASE_NAME, LAST_NAME, LAST_ALIAS})

# The builtins that take one parenthesised argument and need no `-l`.
# `scale` doubles as a register, so it is only a call when a `(` follows
# it, and `length` is otherwise a reserved word, which is why `length=2`
# refuses where `length(1/3)` answers.
BUILTIN_CALLS = frozenset({SQRT_NAME, LENGTH_NAME, SCALE_NAME})

# A reserved word is a syntax error where a name is expected, never a
# variable: `length=2` and `if=1` do not assign.
RESERVED_WORDS = frozenset({
    SCALE_NAME,
    IBASE_NAME,
    OBASE_NAME,
    LAST_NAME,
    SQRT_NAME,
    "length",
    "read",
    "define",
    "auto",
    "return",
    "if",
    "else",
    "while",
    "for",
    "break",
    "continue",
    "halt",
    "quit",
    "print",
    "limits",
    "warranty",
})

# `A` to `Z` are digits worth 10 to 35, so `X` is the number 33 and
# `X=5` assigns to a constant, which is a syntax error.
BASE_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DECIMAL_DIGITS = frozenset("0123456789")
DIGIT_CHARS = frozenset(BASE_DIGITS)
NUMBER_CHARS = DIGIT_CHARS | {"."}
# ASCII only, matching `/[a-z]/` in the TypeScript twin: python's
# `str.isalpha` would also admit an uppercase or non-ASCII letter, and
# the two hosts have to refuse the same lines. A name is
# `[a-z][a-z0-9_]*`, so a leading `_` is not a name at all.
NAME_START = frozenset("abcdefghijklmnopqrstuvwxyz")
NAME_CHARS = NAME_START | DECIMAL_DIGITS | {"_"}
# Every character GNU's lexer has a rule for. One outside this set is
# reported as an illegal character rather than a syntax error, which is
# why `@` and a stray `_` read differently from `)`.
LEGAL_CHARS = (DIGIT_CHARS | NAME_START | frozenset(".+-*/%^=<>!()[]{},;")
               | frozenset('"\\# \t'))
COMPOUND_OPS = "+-*/%^"
STATEMENT_SEPARATOR = ";"
LINE_COMMENT = "#"
BLOCK_OPEN = "/*"
BLOCK_CLOSE = "*/"
STRING_QUOTE = '"'
# What `print` expands in a string. GNU writes nothing at all for an
# escape it has no rule for, dropping both characters, so `\z`, `\0`,
# `\e` and a backslash before the closing quote all vanish. A bare
# string statement is written raw and reaches none of this, which is why
# `"a\nb"` writes a backslash and an `n` where `print "a\nb"` breaks
# the line. The expansion is what reaches the output column, so a tab
# moves the fold one place rather than to the next tab stop, and the
# two source characters never count as two.
PRINT_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "q": '"',
    "r": "\r",
    "t": "\t",
    "\\": "\\",
}
# What a statement is trimmed of at both ends. Spelled out rather than
# left to `str.strip` / `String.trim`, whose sets differ between the two
# hosts; GNU's own whitespace is just space and tab, and it reports the
# other three as illegal characters, which is a separate divergence.
TRIM_CHARS = " \t\r\v\f"


def string_end(text: str, pos: int) -> int:
    """Where the string literal opening at `pos` ends.

    Args:
        text (str): the input the literal sits in.
        pos (int): the offset of the opening quote.

    Returns:
        int: the offset just past the closing quote, or -1 when the input
            holds no second quote. A backslash never escapes the closing
            quote, so a literal ending in one closes there and the text
            after it is ordinary tokens again.
    """
    close = text.find(STRING_QUOTE, pos + 1)
    return -1 if close < 0 else close + 1


def unescape(text: str) -> str:
    """Expand the escapes `print` honours in a string literal's body.

    Args:
        text (str): the body, without its quotes.

    Returns:
        str: the characters `print` writes. An escape GNU has no rule for
            writes nothing, and so does a trailing backslash.
    """
    out: list[str] = []
    pos = 0
    while pos < len(text):
        char = text[pos]
        if char != "\\":
            out.append(char)
            pos += 1
            continue
        out.append(PRINT_ESCAPES.get(text[pos + 1:pos + 2], ""))
        pos += 2
    return "".join(out)


def digit_value(char: str, ibase: int, clamp: bool) -> int:
    """The value of one input digit.

    Args:
        char (str): the digit, `0`-`9` or `A`-`Z`.
        ibase (int): the input base.
        clamp (bool): whether to hold the digit below `ibase`. GNU clamps
            every digit of a multi-digit literal, so `FF` is 99 at base
            10, but leaves a single-digit literal alone, so `X` is 33.

    Returns:
        int: the digit's value.
    """
    value = BASE_DIGITS.index(char)
    if clamp and value >= ibase:
        return ibase - 1
    return value


def decimal_text(whole: str, fraction: str, clamp: bool) -> str:
    """Respell a base-ten literal with each digit's clamped value.

    Reading base ten through the host's own float parser rather than a
    digit loop keeps every literal correctly rounded, which is what makes
    `0.29*0.3` answer the same in both hosts.

    Args:
        whole (str): the digits before the radix point.
        fraction (str): the digits after it.
        clamp (bool): whether digits are held below ten.

    Returns:
        str: a decimal literal the host's float parser accepts.
    """
    before = "".join(str(digit_value(c, DEFAULT_BASE, clamp)) for c in whole)
    after = "".join(str(digit_value(c, DEFAULT_BASE, clamp)) for c in fraction)
    return f"{before or '0'}.{after or '0'}"


def read_base_number(raw: str, ibase: int) -> BcNumber:
    """Read one numeric literal written in the input base.

    Args:
        raw (str): the literal as written.
        ibase (int): the input base.

    Returns:
        BcNumber: the value, scaled by the digits written after the
            point -- a literal keeps its own scale whatever the global
            `scale` is, so `scale=0; 1.9` still prints `1.9`.

    Raises:
        BcParseError: the literal carries a second radix point.
    """
    whole, _, fraction = raw.partition(".")
    if "." in fraction:
        raise BcParseError(SYNTAX_ERROR)
    scale = clamp_scale(len(fraction))
    clamp = len(whole) + len(fraction) > 1
    if ibase == DEFAULT_BASE:
        return BcNumber(float(decimal_text(whole, fraction, clamp)), scale)
    value = 0.0
    for char in whole:
        value = value * ibase + digit_value(char, ibase, clamp)
    factor = 1.0
    for char in fraction:
        factor /= ibase
        value += digit_value(char, ibase, clamp) * factor
    return BcNumber(value, scale)


def truncate_to_scale(value: float, scale: int) -> float:
    """Drop the digits past `scale`, rounding toward zero as bc does.

    Args:
        value (float): the value to truncate.
        scale (int): fractional digits to keep.

    Returns:
        float: the truncated value, or the value unchanged when scaling
            it would leave float64's range.
    """
    # Built as an exact integer power and converted once, which is the
    # correctly-rounded double for every scale here. `10.0**scale` is not:
    # libm's `pow` puts `10.0**23` one ulp above `1e23`, while the
    # TypeScript side reads the decimal literal `1e23` and gets the
    # correctly-rounded value, so the two hosts would disagree in the
    # last digits at scale 23 and nowhere else. `scale` is always
    # `clamp_scale`d to 0..100, so the integer power cannot overflow.
    factor = float(10**scale)
    scaled = value * factor
    if not math.isfinite(scaled):
        return value
    return math.trunc(scaled) / factor


def exact_fraction(magnitude: float, digits: int) -> str:
    """The first `digits` fractional digits of a value below one, exact.

    A float is a dyadic rational, so its decimal expansion is finite and
    can be truncated rather than rounded. Formatting at `MAX_SCALE` and
    slicing cannot: that asks each host's formatter to round at the
    hundredth digit, and python's rounds half to even where JavaScript's
    `toFixed` rounds half away from zero, so 2^-101 -- whose expansion
    is exactly 101 digits long, the last of them a 5 -- came out
    differently in the two. Truncating is also what GNU does whenever it
    reduces a value to a scale.

    Args:
        magnitude (float): a finite value, not negative and below one.
        digits (int): how many fractional digits to return.

    Returns:
        str: exactly `digits` digits, left-padded with zeros.
    """
    numerator, denominator = magnitude.as_integer_ratio()
    return str(numerator * 10**digits // denominator).rjust(digits, "0")


def fixed_digits(value: float, scale: int) -> str:
    """Spell `value` with `scale` fractional digits, truncating.

    GNU truncates toward zero whenever it reduces a value to a scale; it
    never rounds and never floors, so `1.5*2.5` is `3.7`. Truncating the
    digits here is what makes that true: python's float formatting
    rounds half to even, so `f"{3.75:.1f}"` prints `3.8`.

    The digits truncated are the *shortest* ones that read back as this
    float, not the float's full expansion. That is what keeps the
    operation stable: a value stored and printed again prints the same
    digits, where truncating the full expansion would turn the `.3` of
    `0.1+0.2` into `.2` the second time round.

    Args:
        value (float): the value to spell; must be finite.
        scale (int): fractional digits to keep, padded with zeros.

    Returns:
        str: the signed digits, without bc's leading-zero rule applied.
    """
    magnitude = abs(value)
    if magnitude < PLAIN_MIN:
        whole, fraction = "0", exact_fraction(magnitude, MAX_SCALE)
    else:
        if magnitude < PLAIN_MAX:
            text = repr(magnitude)
        else:
            text = f"{magnitude:.{MAX_SCALE}f}"
        whole, _, fraction = text.partition(".")
    sign = "-" if value < 0 else ""
    if scale == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{fraction[:scale].ljust(scale, '0')}"


def reduce_number(num: BcNumber) -> BcNumber:
    """Cut a value down to the scale it carries.

    An assignment stores the reduced value, which is why raising `scale`
    after one cannot recover the digits a narrower scale dropped.

    Args:
        num (BcNumber): the value and the scale it carries.

    Returns:
        BcNumber: the same value with everything past its scale dropped.
    """
    scale = clamp_scale(num.scale)
    if not math.isfinite(num.value):
        return BcNumber(num.value, scale)
    return BcNumber(float(fixed_digits(num.value, scale)), scale)


def nonfinite_text(value: float) -> str:
    """Spell an infinity or NaN the way JavaScript's `String` spells it.

    GNU bc is exact and has no such value, so there is nothing to match
    against; matching the other host is what is left.

    Args:
        value (float): a value that is not finite.

    Returns:
        str: `NaN`, `Infinity` or `-Infinity`.
    """
    if math.isnan(value):
        return "NaN"
    return "Infinity" if value > 0 else "-Infinity"


def render_in_base(value: float, scale: int, obase: int) -> str:
    """Spell one non-negative value in an output base other than ten.

    Args:
        value (float): the magnitude to spell, already reduced.
        scale (int): fractional digits to emit, counted in `obase`.
        obase (int): the output base.

    Returns:
        str: the digits, with no sign and no leading zero before a bare
            fraction. Up to base 16 a digit is one character; above it
            each digit becomes a space-separated decimal group, so 255
            at base 100 is ` 02 55`.
    """
    whole = int(math.trunc(value))
    rest = value - math.trunc(value)
    before: list[int] = []
    while whole > 0:
        before.append(whole % obase)
        whole //= obase
    before.reverse()
    after: list[int] = []
    for _ in range(scale):
        rest *= obase
        digit = int(math.trunc(rest))
        after.append(digit)
        rest -= digit
    if obase <= MAX_CHAR_BASE:
        text = "".join(BASE_DIGITS[d] for d in before)
        if after:
            text += "." + "".join(BASE_DIGITS[d] for d in after)
    else:
        width = len(str(obase - 1))
        text = "".join(f" {d:0{width}d}" for d in before)
        if after:
            text += "." + "".join(f" {d:0{width}d}" for d in after)
    return text or "0"


def render_number(num: BcNumber, obase: int) -> str:
    """Render one printed bc value.

    Two GNU spellings that are easy to miss: an exact zero prints as a
    bare `0` whatever the scale, and a value below one carries no
    leading zero, so `0.1+0.2` is `.3` rather than `0.3`.

    Args:
        num (BcNumber): the value and the scale it prints with.
        obase (int): the output base.

    Returns:
        str: the line bc would print, without its newline.
    """
    if not math.isfinite(num.value):
        return nonfinite_text(num.value)
    scale = clamp_scale(num.scale)
    reduced = reduce_number(num)
    if reduced.value == 0:
        return "0"
    if obase == DEFAULT_BASE:
        text = fixed_digits(num.value, scale)
    else:
        text = render_in_base(abs(reduced.value), scale, obase)
        if reduced.value < 0:
            text = "-" + text
    if text.startswith("0."):
        return text[1:]
    if text.startswith("-0."):
        return "-" + text[2:]
    return text


def c_atoi(text: str) -> int:
    """Read an integer from `text` the way C's `atoi` does.

    GNU reads `BC_LINE_LENGTH` with `atoi`, which is lenient where a
    host's own integer parser is strict: it skips leading blanks, takes
    one optional sign, stops at the first character that is not a digit,
    and answers 0 when there was no digit at all -- so `abc`, an empty
    value and `0x46` all read as 0, which is what turns folding off.

    Args:
        text (str): the raw environment value.

    Returns:
        int: the value, in the range of a signed 32-bit int. glibc's
            `atoi` is `strtol` saturated to a signed 64-bit range and
            then truncated, and both steps show: `4294967296` reads as 0
            and `9223372036854775808` as -1.
    """
    body = text.lstrip(C_BLANKS)
    negative = body[:1] == "-"
    if body[:1] in ("+", "-"):
        body = body[1:]
    digits = ""
    for char in body:
        if char not in DECIMAL_DIGITS:
            break
        digits += char
    if digits == "":
        return 0
    value = -int(digits) if negative else int(digits)
    limit = 1 << (C_LONG_BITS - 1)
    value = max(-limit, min(value, limit - 1))
    value &= (1 << C_INT_BITS) - 1
    if value >= 1 << (C_INT_BITS - 1):
        value -= 1 << C_INT_BITS
    return value


def output_line_size(env: Mapping[str, str] | None) -> int:
    """GNU's `line_size`: how wide one output line may be.

    Args:
        env (Mapping[str, str] | None): the session environment, or None
            outside a workspace, where the default applies.

    Returns:
        int: the width, or 0 for no folding.
    """
    raw = None if env is None else env.get(LINE_LENGTH_VAR)
    if raw is None:
        return DEFAULT_LINE_LENGTH
    size = c_atoi(raw)
    if size != 0 and size < MIN_LINE_LENGTH:
        return DEFAULT_LINE_LENGTH
    return size


# Where the UTF-8 encoding of a code point changes width. GNU counts the
# bytes it writes, not the characters, so a two-byte `é` moves the fold
# twice as far as an `x`; derived from the code point rather than by
# encoding each character, so the two hosts count one number.
UTF8_TWO_BYTES = 0x80
UTF8_THREE_BYTES = 0x800
UTF8_FOUR_BYTES = 0x10000


def column_width(char: str) -> int:
    """How far one written character moves GNU's output column.

    Args:
        char (str): one character.

    Returns:
        int: its UTF-8 byte length, 1 to 4.
    """
    point = ord(char)
    if point < UTF8_TWO_BYTES:
        return 1
    if point < UTF8_THREE_BYTES:
        return 2
    if point < UTF8_FOUR_BYTES:
        return 3
    return 4


@dataclass(slots=True)
class OutputColumn:
    """GNU's `out_col`: how full the current output line is.

    One counter for the whole run, not one per value: `print` ends in no
    newline, so a string it wrote moves the column a later value folds
    at. Only written output folds; a diagnostic never does.

    Args:
        line_size (int): the width from `output_line_size`; 0 folds
            nothing, however long the output is.
        col (int): bytes already written on the current line.
    """

    line_size: int
    col: int = 0

    def write(self, text: str) -> str:
        """Fold `text` into the output and advance the column.

        Args:
            text (str): the characters to write.

        Returns:
            str: the characters with a backslash and a newline at every
                break. A newline in `text` starts the line over, so an
                expression statement's own newline is what makes the next
                value begin at the left margin.
        """
        out: list[str] = []
        for char in text:
            if char == "\n":
                self.col = 0
                out.append(char)
                continue
            width = column_width(char)
            # A folded line carries `line_size - 2` bytes and then a
            # backslash, so the default 70 puts 68 of them on a line and
            # makes it 69 wide. A character that would cross that
            # boundary moves whole to the next line; GNU, writing one
            # byte at a time, splits it there instead and emits bytes
            # that are no longer UTF-8. The fold lands in the same place
            # whenever a character does not straddle it, which is every
            # ASCII one. The `col != 0` guard keeps a character wider
            # than the whole line from folding forever.
            if (self.line_size != 0 and self.col != 0
                    and self.col + width > self.line_size - 2):
                out.append("\\\n")
                self.col = 0
            out.append(char)
            self.col += width
        return "".join(out)


def runtime_line(kind: str, reason: str) -> str:
    """GNU's stderr line for a non-fatal runtime error or warning.

    Args:
        kind (str): `error` or `warning`.
        reason (str): the reason text, e.g. `Divide by zero`.

    Returns:
        str: the full line, without its newline.
    """
    return f"Runtime {kind} (func=(main), adr={RUNTIME_ERROR_ADDR}): {reason}"


def runtime_error_line(reason: str) -> str:
    """GNU's stderr line for a non-fatal runtime error.

    Args:
        reason (str): the reason text, e.g. `Divide by zero`.

    Returns:
        str: the full line, without its newline.
    """
    return runtime_line("error", reason)


def runtime_warning_line(reason: str) -> str:
    """GNU's stderr line for a clamped register value.

    Args:
        reason (str): the reason text, e.g. `obase too small, set to 2`.

    Returns:
        str: the full line, without its newline.
    """
    return runtime_line("warning", reason)


def parse_error_line(line: int, text: str) -> str:
    """GNU's stderr line for a parse diagnostic.

    Args:
        line (int): the input line, counted from 1 per invocation.
        text (str): the diagnostic body.

    Returns:
        str: the full line, without its newline.
    """
    return f"{INPUT_NAME} {line}: {text}"


def assignable(name: str) -> bool:
    """Whether `name` can be assigned to or incremented.

    Args:
        name (str): the name read from the input, possibly empty.

    Returns:
        bool: True for a register and for any non-reserved name.
    """
    if name in REGISTERS:
        return True
    return name != "" and name not in RESERVED_WORDS


def add_scale(a: BcNumber, b: BcNumber) -> int:
    """The scale bc gives a sum or difference.

    Args:
        a (BcNumber): the left operand.
        b (BcNumber): the right operand.

    Returns:
        int: the wider of the two operand scales.
    """
    return clamp_scale(max(a.scale, b.scale))


def mul_scale(a: BcNumber, b: BcNumber, scale: int) -> int:
    """The scale bc gives a product.

    Args:
        a (BcNumber): the left operand.
        b (BcNumber): the right operand.
        scale (int): the global scale register.

    Returns:
        int: `min(scale(a)+scale(b), max(scale, scale(a), scale(b)))`.
    """
    return clamp_scale(min(a.scale + b.scale, max(scale, a.scale, b.scale)))


def pow_scale(a: BcNumber, exponent: int, scale: int) -> int:
    """The scale bc gives a power.

    Args:
        a (BcNumber): the base.
        exponent (int): the truncated integer exponent.
        scale (int): the global scale register.

    Returns:
        int: the global scale for a negative exponent, otherwise
            `min(scale(a)*exponent, max(scale, scale(a)))`.
    """
    if exponent < 0:
        return clamp_scale(scale)
    return clamp_scale(min(a.scale * exponent, max(scale, a.scale)))


def divide(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    """bc's `/`: truncate the quotient to the global scale.

    Args:
        a (BcNumber): the dividend.
        b (BcNumber): the divisor.
        scale (int): the global scale register.

    Returns:
        BcNumber: the quotient at the global scale.

    Raises:
        BcRuntimeError: the divisor is zero.
    """
    if b.value == 0:
        raise BcRuntimeError(DIVIDE_BY_ZERO)
    return BcNumber(truncate_to_scale(a.value / b.value, scale),
                    clamp_scale(scale))


def modulo(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    """bc's `%`: `a - (a/b)*b`, with the quotient truncated first.

    The remainder therefore takes the dividend's sign, so `-7%2` is -1.

    Args:
        a (BcNumber): the dividend.
        b (BcNumber): the divisor.
        scale (int): the global scale register.

    Returns:
        BcNumber: the remainder, at `max(scale+scale(b), scale(a))`.

    Raises:
        BcRuntimeError: the divisor is zero.
    """
    if b.value == 0:
        raise BcRuntimeError(MODULO_BY_ZERO)
    quotient = truncate_to_scale(a.value / b.value, scale)
    return BcNumber(a.value - quotient * b.value,
                    clamp_scale(max(scale + b.scale, a.scale)))


def apply_binary(op: str, a: BcNumber, b: BcNumber,
                 state: BcState) -> BcNumber:
    """Apply one arithmetic operator, scale rules included.

    The whole state rather than just the scale, because `^` warns: GNU
    reports an exponent that carries a scale before truncating it, and a
    warning is state the statement collects.

    Args:
        op (str): one of `+ - * / % ^`.
        a (BcNumber): the left operand.
        b (BcNumber): the right operand.
        state (BcState): the run's registers and warning buffer.

    Returns:
        BcNumber: the result and the scale bc gives it.
    """
    scale = state.scale
    if op == "+":
        return BcNumber(a.value + b.value, add_scale(a, b))
    if op == "-":
        return BcNumber(a.value - b.value, add_scale(a, b))
    if op == "*":
        return BcNumber(a.value * b.value, mul_scale(a, b, scale))
    if op == "/":
        return divide(a, b, scale)
    if op == "%":
        return modulo(a, b, scale)
    exponent = truncate_int(b.value)
    if b.scale != 0:
        # Before the refusal a zero base raises, which is the order GNU
        # reports the two in for `0^-1.5`.
        state.warnings.append(runtime_warning_line(NONZERO_EXPONENT_SCALE))
    return BcNumber(float_pow(a.value, exponent),
                    pow_scale(a, exponent, scale))


def call_function(name: str, arg: BcNumber, scale: int) -> BcNumber:
    """Apply one built-in or math-library function.

    Args:
        name (str): the function name, already known to exist.
        arg (BcNumber): the argument.
        scale (int): the global scale register.

    Returns:
        BcNumber: the result at `max(scale, scale(arg))`, except for the
            square root of one, which GNU answers at scale 0.
    """
    result_scale = clamp_scale(max(scale, arg.scale))
    if name == LOG_NAME and arg.value <= 0:
        value = log_domain_value(clamp_scale(scale))
    elif name == SQRT_NAME:
        value = bc_sqrt(arg.value)
        if arg.value == 1:
            # GNU's `bc_sqrt` short-circuits an argument of exactly one
            # to its own canonical one, which carries no scale, so
            # `scale=100; sqrt(1)` prints a bare `1` where
            # `scale=5; sqrt(4)` prints `2.00000`. The rule is narrower
            # than "a perfect square": every other exact root is padded.
            # It compares the value, not the digits written, so
            # `sqrt(1.00)` and `sqrt(3/3)` are bare too, and GNU's
            # `scale(sqrt(1))` is 0 rather than the global scale.
            result_scale = 0
    else:
        value = MATH_FUNCS[name](arg.value)
    return BcNumber(value, result_scale)


def bc_length(num: BcNumber) -> int:
    """GNU's `length()`: the significant decimal digits in a value.

    The integer part's leading zeros do not count, so `length(0.5)` is 1
    and `length(007)` is 1, while the fraction's do, so `length(0.05)` is
    2. A zero carrying no fractional digits is 1 rather than 0.

    Args:
        num (BcNumber): the value and the scale it carries.

    Returns:
        int: the digit count, or 0 for a value that is not finite -- GNU
            is exact and has no infinity whose digits could be counted,
            so both hosts answer one agreed number instead.
    """
    if not math.isfinite(num.value):
        return 0
    scale = clamp_scale(num.scale)
    whole = fixed_digits(abs(num.value), scale).partition(".")[0]
    return (len(whole.lstrip("0")) + scale) or 1


def call_builtin(name: str, arg: BcNumber, scale: int) -> BcNumber:
    """Apply one builtin that needs no math library.

    Args:
        name (str): `sqrt`, `length` or `scale`.
        arg (BcNumber): the argument.
        scale (int): the global scale register.

    Returns:
        BcNumber: the result. `length` and `scale` answer a count, which
            is an integer at scale 0 whatever scale the argument carries.
    """
    if name == LENGTH_NAME:
        return BcNumber(float(bc_length(arg)), 0)
    if name == SCALE_NAME:
        return BcNumber(float(clamp_scale(arg.scale)), 0)
    return call_function(SQRT_NAME, arg, scale)


class Parser:
    """A recursive-descent parser for one bc statement.

    It replaces the `eval()` this command used to run on agent-typed
    text, and mirrors `Parser` in `bc.ts` method for method so the two
    hosts accept and refuse the same lines.

    Args:
        src (str): the statement text.
        state (BcState): the run's registers, symbol table and
            math-library flag.
        writes (list[str]): where the statement's output is appended,
            already rendered. Owned by the caller so that the text a
            statement produced before a runtime error survives it:
            `print "x", 1/0` writes the `x` GNU had already written when
            the division refused.
    """

    __slots__ = ("_src", "_pos", "_state", "_writes")

    def __init__(self, src: str, state: BcState, writes: list[str]) -> None:
        self._src = src
        self._pos = 0
        self._state = state
        self._writes = writes

    def _skip_blanks(self) -> None:
        while self._pos < len(self._src) and self._src[self._pos] in " \t":
            self._pos += 1

    def _peek(self) -> str:
        self._skip_blanks()
        if self._pos < len(self._src):
            return self._src[self._pos]
        return ""

    def _consume(self) -> str:
        char = self._peek()
        self._pos += 1
        return char

    def _match(self, text: str) -> bool:
        self._skip_blanks()
        if self._src.startswith(text, self._pos):
            self._pos += len(text)
            return True
        return False

    def unexpected(self) -> BcParseError:
        """The diagnostic for whatever sits at the cursor.

        Returns:
            BcParseError: an illegal-character report for a character
                GNU's lexer has no rule for, otherwise a syntax error,
                marked incomplete when the input simply ran out.
        """
        char = self._peek()
        # A `"` the input never closes matches no lexer rule either, so it
        # is an illegal character where a closed one is an ordinary token
        # in the wrong place: `1+"a` reports the quote and `1+"a"` a
        # syntax error.
        if char == STRING_QUOTE and string_end(self._src, self._pos) < 0:
            return BcParseError(f"{ILLEGAL_CHARACTER}: {char}", pos=self._pos)
        if char != "" and char not in LEGAL_CHARS:
            return BcParseError(f"{ILLEGAL_CHARACTER}: {char}", pos=self._pos)
        return BcParseError(SYNTAX_ERROR, incomplete=char == "", pos=self._pos)

    def _read_number(self) -> BcNumber:
        start = self._pos
        while (self._pos < len(self._src)
               and self._src[self._pos] in NUMBER_CHARS):
            self._pos += 1
        try:
            return read_base_number(self._src[start:self._pos],
                                    self._state.ibase)
        except BcParseError as exc:
            raise BcParseError(exc.text, exc.incomplete, start) from exc

    def _read_identifier(self) -> str:
        if (self._pos >= len(self._src)
                or self._src[self._pos] not in NAME_START):
            return ""
        start = self._pos
        self._pos += 1
        while (self._pos < len(self._src)
               and self._src[self._pos] in NAME_CHARS):
            self._pos += 1
        return self._src[start:self._pos]

    def _emit(self, num: BcNumber) -> str:
        """Render one value the moment the statement reaches it.

        GNU writes a value where its own instruction runs, not at the end
        of the statement, so everything an element changes before it is
        already in force and everything a later element changes is not:
        `print 255, obase=16` writes `255` and then `10`, and
        `print 5, last` writes the 5 twice.

        Args:
            num (BcNumber): the value the element evaluated to.

        Returns:
            str: the value in the output base as it stands now.
        """
        self._state.last = reduce_number(num)
        return render_number(num, self._state.obase)

    def _read_string(self) -> str:
        self._skip_blanks()
        start = self._pos
        end = string_end(self._src, start)
        if end < 0:
            raise self.unexpected()
        self._pos = end
        return self._src[start + 1:end - 1]

    def _read_target(self) -> str:
        self._skip_blanks()
        name = self._read_identifier()
        if name != "":
            return name
        if (self._pos < len(self._src) and self._src[self._pos] == LAST_ALIAS
                and self._src[self._pos + 1:self._pos + 2] not in DIGIT_CHARS):
            self._pos += 1
            return LAST_ALIAS
        return ""

    def parse_statement(self) -> None:
        """Parse one statement, appending whatever it writes.

        An assignment writes nothing, which is why `x=5` prints where
        `(x=5)` does not; an increment is not an assignment, so `x++`
        prints 5. Only an expression statement writes a trailing newline,
        which is what leaves `print` and a bare string mid-line.
        """
        if self._is_halt():
            raise BcHalt()
        if self._peek() == STRING_QUOTE:
            # A bare string is written exactly as it was typed: GNU
            # expands escapes for `print` alone, so `"a\n"` writes a
            # backslash and an `n`. It does not touch `last` either.
            self._writes.append(self._read_string())
            return
        if self._is_print():
            self._parse_print()
            return
        probe = self._try_assignment()
        if probe is None:
            self._writes.append(self._emit(self.parse_expr()))
            self._writes.append("\n")
            return
        name, op = probe
        self._assign(name, op, self.parse_expr())

    def _is_print(self) -> bool:
        # A whole identifier, so `printx` stays an ordinary variable, and
        # a keyword rather than a name, so `print=1` and `1+print` are
        # still syntax errors on the reserved word.
        mark = self._pos
        self._skip_blanks()
        if self._read_identifier() == PRINT_NAME:
            return True
        self._pos = mark
        return False

    def _parse_print(self) -> None:
        # Each element is written as it is reached, so a refusal partway
        # down the list keeps what came before it. A string element is
        # unescaped where the same string alone is not, and an expression
        # element prints even when it is an assignment: `print x=5`
        # writes 5 where the statement `x=5` writes nothing.
        while True:
            if self._peek() == STRING_QUOTE:
                self._writes.append(unescape(self._read_string()))
            else:
                self._writes.append(self._emit(self.parse_expr()))
            if not self._match(","):
                return

    def _is_halt(self) -> bool:
        # `halt` is a statement, never part of an expression, so it only
        # counts when it is the whole statement: `halt 1+1`, `1+halt` and
        # `x=halt` all stay syntax errors on the reserved word.
        mark = self._pos
        self._skip_blanks()
        if self._read_identifier() == HALT_NAME and self.done():
            return True
        self._pos = mark
        return False

    def _try_assignment(self) -> tuple[str, str] | None:
        mark = self._pos
        name = self._read_target()
        if not assignable(name):
            self._pos = mark
            return None
        self._skip_blanks()
        rest = self._src[self._pos:]
        for op in COMPOUND_OPS:
            if rest.startswith(f"{op}="):
                self._pos += 2
                return name, op
        # `x =- 2` is `=` then a negation, not the historical `-=`, so
        # the compound spellings are read before the bare `=` and never
        # across it.
        if rest.startswith("=") and not rest.startswith("=="):
            self._pos += 1
            return name, ""
        self._pos = mark
        return None

    def _assign(self, name: str, op: str, rhs: BcNumber) -> BcNumber:
        value = rhs
        if op != "":
            value = apply_binary(op, self._read_value(name), rhs, self._state)
        self._store(name, value)
        return self._read_value(name)

    def _read_value(self, name: str) -> BcNumber:
        state = self._state
        if name == SCALE_NAME:
            return BcNumber(float(state.scale), 0)
        if name == IBASE_NAME:
            return BcNumber(float(state.ibase), 0)
        if name == OBASE_NAME:
            return BcNumber(float(state.obase), 0)
        if name in (LAST_NAME, LAST_ALIAS):
            return state.last
        return state.variables.get(name, ZERO)

    def _store(self, name: str, num: BcNumber) -> None:
        state = self._state
        requested = truncate_int(num.value)
        if name == SCALE_NAME:
            if requested < 0:
                state.warnings.append(runtime_warning_line(NEGATIVE_SCALE))
                requested = 0
            state.scale = clamp_scale(requested)
            return
        if name == IBASE_NAME:
            state.ibase = self._clamp_base(requested, MAX_IBASE,
                                           IBASE_TOO_SMALL)
            return
        if name == OBASE_NAME:
            state.obase = self._clamp_base(requested, MAX_OBASE,
                                           OBASE_TOO_SMALL)
            return
        # The stored value is already truncated, so raising `scale`
        # afterwards cannot recover digits a narrower scale dropped.
        if name in (LAST_NAME, LAST_ALIAS):
            state.last = reduce_number(num)
            return
        state.variables[name] = reduce_number(num)

    def _clamp_base(self, requested: int, ceiling: int, warning: str) -> int:
        if requested < MIN_BASE:
            self._state.warnings.append(runtime_warning_line(warning))
            return MIN_BASE
        return min(requested, ceiling)

    def parse_expr(self) -> BcNumber:
        """Parse an expression, assignment included.

        Assignment is part of the expression grammar, not just the
        statement one, which is why a bare `x=5` prints nothing but
        `(x=5)` prints 5.

        Returns:
            BcNumber: the value and its scale.
        """
        probe = self._try_assignment()
        if probe is None:
            return self._parse_additive()
        name, op = probe
        return self._assign(name, op, self.parse_expr())

    def _parse_additive(self) -> BcNumber:
        left = self._parse_term()
        while True:
            char = self._peek()
            if char not in ("+", "-"):
                return left
            # GNU's lexer reads `++` and `--` as one token each, so a
            # doubled sign is never an operator followed by a sign:
            # `1++2` is refused where `1+ +2` would be `1 + (+2)` if
            # there were a unary `+`, and there is not.
            if self._src.startswith(char * 2, self._pos):
                return left
            self._consume()
            left = apply_binary(char, left, self._parse_term(), self._state)

    def _parse_term(self) -> BcNumber:
        left = self._parse_unary()
        while True:
            char = self._peek()
            if char not in ("*", "/", "%"):
                return left
            self._consume()
            left = apply_binary(char, left, self._parse_unary(), self._state)

    def _parse_unary(self) -> BcNumber:
        if self._match("++"):
            return self._parse_prefix_step(1)
        if self._match("--"):
            return self._parse_prefix_step(-1)
        char = self._peek()
        if char == "-":
            self._consume()
            operand = self._parse_unary()
            return BcNumber(-operand.value, operand.scale)
        # No unary `+`: GNU has no such operator, so `+5` is a syntax
        # error charged to its own line rather than an incomplete
        # construct charged to the next one.
        return self._parse_power()

    def _parse_prefix_step(self, delta: int) -> BcNumber:
        name = self._read_target()
        if not assignable(name):
            raise self.unexpected()
        old = self._read_value(name)
        self._store(name, BcNumber(old.value + delta, old.scale))
        return self._read_value(name)

    def _parse_power(self) -> BcNumber:
        base = self._parse_atom()
        if self._peek() != "^":
            return base
        self._consume()
        return apply_binary("^", base, self._parse_unary(), self._state)

    def _parse_atom(self) -> BcNumber:
        char = self._peek()
        if char == "(":
            self._consume()
            value = self.parse_expr()
            if not self._match(")"):
                raise self.unexpected()
            return value
        if char == LAST_ALIAS:
            if self._src[self._pos + 1:self._pos + 2] in DIGIT_CHARS:
                return self._read_number()
            return self._parse_name()
        if char in DIGIT_CHARS:
            return self._read_number()
        if char in NAME_START:
            return self._parse_name()
        raise self.unexpected()

    def _parse_name(self) -> BcNumber:
        self._skip_blanks()
        start = self._pos
        name = self._read_target()
        if name in BUILTIN_CALLS:
            if self._peek() == "(":
                return self._parse_builtin_call(name)
            if name == SCALE_NAME:
                return self._parse_postfix(name)
            # A builtin with no `(` is a legal prefix, so GNU charges the
            # failure to the line after it: bare `length` and bare `sqrt`
            # report the next line where `length=2` reports their own.
            raise BcParseError(SYNTAX_ERROR,
                               incomplete=self._peek() == "",
                               pos=start)
        if name in REGISTERS:
            return self._parse_postfix(name)
        if name in RESERVED_WORDS:
            raise BcParseError(SYNTAX_ERROR, pos=start)
        if self._match("("):
            arg = self.parse_expr()
            if not self._match(")"):
                raise self.unexpected()
            if self._state.math_mode and name in MATH_FUNCS:
                return call_function(name, arg, self._state.scale)
            # GNU compiles the call and only then finds no such function,
            # so this is the runtime shape, with a trailing period.
            raise BcRuntimeError(f"Function {name} not defined.")
        return self._parse_postfix(name)

    def _parse_builtin_call(self, name: str) -> BcNumber:
        self._consume()
        arg = self.parse_expr()
        if not self._match(")"):
            raise self.unexpected()
        return call_builtin(name, arg, self._state.scale)

    def _parse_postfix(self, name: str) -> BcNumber:
        # An undefined name reads as 0, silently; only writing to a
        # reserved word is an error.
        value = self._read_value(name)
        if self._match("++"):
            self._store(name, BcNumber(value.value + 1, value.scale))
        elif self._match("--"):
            self._store(name, BcNumber(value.value - 1, value.scale))
        return value

    def done(self) -> bool:
        """Whether the whole statement was consumed.

        Returns:
            bool: True when only blanks remain.
        """
        self._skip_blanks()
        return self._pos >= len(self._src)


def eval_statement(text: str, state: BcState, writes: list[str]) -> None:
    """Evaluate one bc statement against the run's state.

    Args:
        text (str): the statement, already split off and stripped.
        state (BcState): the run's registers and symbol table.
        writes (list[str]): where the statement's output is appended,
            already rendered. A refusal leaves behind whatever was
            written before it.

    Raises:
        BcParseError: the statement cannot be parsed.
        BcRuntimeError: a non-fatal runtime error such as a zero divisor.
    """
    parser = Parser(text, state, writes)
    parser.parse_statement()
    if not parser.done():
        raise parser.unexpected()


def all_blank(text: str) -> bool:
    """Whether `text` holds nothing but blanks.

    Args:
        text (str): the text to test.

    Returns:
        bool: True when every character is one a statement is trimmed of.
    """
    return all(char in TRIM_CHARS for char in text)


def trim_piece(text: str, lines: list[int]) -> tuple[str, list[int]]:
    """Drop the blanks at both ends of a statement and its line map.

    Args:
        text (str): the statement source.
        lines (list[int]): the input line per character of `text`.

    Returns:
        tuple[str, list[int]]: the trimmed text and the matching slice of
            the line map, which has to stay the same length so an offset
            still names a line.
    """
    start = 0
    end = len(text)
    while start < end and text[start] in TRIM_CHARS:
        start += 1
    while end > start and text[end - 1] in TRIM_CHARS:
        end -= 1
    return text[start:end], lines[start:end]


def quit_offset(text: str) -> int:
    """Where GNU's lexer meets a `quit` token on one input line.

    `quit` is read by the lexer, which exits the moment it reaches one,
    so nothing later on that line is ever scanned and the line itself
    never runs. Only a whole identifier counts, which is why `quitx` is
    an ordinary variable, and a `quit` inside a number or a string
    literal is not one either.

    Args:
        text (str): one input line, comments already removed.

    Returns:
        int: the offset of the `quit`, or -1 when the line has none.
    """
    pos = 0
    while pos < len(text):
        char = text[pos]
        if char in NAME_START:
            start = pos
            pos += 1
            while pos < len(text) and text[pos] in NAME_CHARS:
                pos += 1
            if text[start:pos] == QUIT_NAME:
                return start
        elif char in NUMBER_CHARS:
            while pos < len(text) and text[pos] in NUMBER_CHARS:
                pos += 1
        elif char == STRING_QUOTE:
            # An unterminated quote is one illegal character and scanning
            # resumes right after it, so a `quit` behind one still ends
            # the run.
            end = string_end(text, pos)
            pos = pos + 1 if end < 0 else end
        else:
            pos += 1
    return -1


def cut_at_quit(text: str, lines: list[int]) -> tuple[str, list[int], bool]:
    """Trim one input line at the `quit` its lexer would exit on.

    GNU hands `quit` to the parser, which ends the run on it as a whole
    statement and refuses it anywhere else, so the keyword is kept when
    something precedes it in its own statement (`1 quit` is a syntax
    error) and dropped when nothing does (`1+1;quit` is silent).

    Args:
        text (str): one input line, comments already removed.
        lines (list[int]): the input line per character of `text`.

    Returns:
        tuple[str, list[int], bool]: the kept text, its line map, and
            whether the line quits.
    """
    cut = quit_offset(text)
    if cut < 0:
        return text, lines, False
    head = text[:cut].rpartition(STATEMENT_SEPARATOR)[2]
    end = cut if all_blank(head) else cut + len(QUIT_NAME)
    return text[:end], lines[:end], True


def line_statements(text: str, lines: list[int],
                    end_line: int) -> tuple[list[BcStatement], bool]:
    """Split one input line into statements.

    Args:
        text (str): the line, comments already removed.
        lines (list[int]): the input line per character of `text`.
        end_line (int): the input line the terminating newline sits on.

    Returns:
        tuple[list[BcStatement], bool]: the statements, and whether a
            `quit` on this line ends the run.
    """
    text, lines, quits = cut_at_quit(text, lines)
    out: list[BcStatement] = []
    start = 0
    index = 0
    while index <= len(text):
        if index < len(text):
            char = text[index]
            # A `;` inside a string is content, not a separator, so the
            # whole token is stepped over before the next one is looked
            # for.
            if char == STRING_QUOTE:
                end = string_end(text, index)
                index = index + 1 if end < 0 else end
                continue
            if char != STATEMENT_SEPARATOR:
                index += 1
                continue
        piece, piece_lines = trim_piece(text[start:index], lines[start:index])
        if piece != "":
            # The token that follows decides where an incomplete
            # construct is charged: a `;` sits on the current line, while
            # a newline has already moved the counter on.
            incomplete = (lines[index] if index < len(text) else end_line + 1)
            out.append(
                BcStatement(piece, tuple(piece_lines), incomplete, not quits))
        start = index + 1
        index += 1
    return out, quits


def parse_input(text: str) -> tuple[list[list[BcStatement]], bool]:
    """Read bc's input into statements, stripping its comments.

    `#` runs to the end of its line and leaves the newline in place, so
    the newline still terminates the statement and the line counter still
    advances -- which is what keeps a later diagnostic on the right line.
    A `/* */` comment becomes one space, so it separates tokens rather
    than vanishing (`1/*c*/2` is `1 2`), and the newlines inside one
    advance the counter without ending the statement. A string is neither:
    it is copied verbatim, so `"a#b"` keeps its hash and a string carrying
    a newline keeps the statement open across the line break.

    Args:
        text (str): the decoded stdin.

    Returns:
        tuple[list[list[BcStatement]], bool]: the statements of each
            logical line, in order, and whether a block comment ran to
            the end of the input, which GNU reports and which discards
            the statements it was reading. The grouping is what GNU runs
            as one unit -- a whole `semicolon_list`, however many input
            lines a block comment stretched it over -- so a parse error
            anywhere in a group discards the whole group.
    """
    lines: list[list[BcStatement]] = []
    chars: list[str] = []
    char_lines: list[int] = []
    pos = 0
    line = 1
    while pos < len(text):
        char = text[pos]
        if char == STRING_QUOTE:
            end = string_end(text, pos)
            if end > 0:
                # The token is copied as it stands: a `#` or a `/*` in it
                # is content, and a newline in it advances the counter
                # without ending the logical line, so a diagnostic after
                # a string that spans lines still names its own line.
                for index in range(pos, end):
                    chars.append(text[index])
                    char_lines.append(line)
                    if text[index] == "\n":
                        line += 1
                pos = end
                continue
            # No closing quote anywhere: the parser reports this one as an
            # illegal character, and the rest of the input lexes as
            # usual, comments included.
        if char == LINE_COMMENT:
            while pos < len(text) and text[pos] != "\n":
                pos += 1
            continue
        if text.startswith(BLOCK_OPEN, pos):
            pos += len(BLOCK_OPEN)
            while pos < len(text) and not text.startswith(BLOCK_CLOSE, pos):
                if text[pos] == "\n":
                    line += 1
                pos += 1
            if pos >= len(text):
                return lines, True
            pos += len(BLOCK_CLOSE)
            chars.append(" ")
            char_lines.append(line)
            continue
        if char == "\n":
            found, quits = line_statements("".join(chars), char_lines, line)
            if found:
                lines.append(found)
            if quits:
                return lines, False
            chars = []
            char_lines = []
            line += 1
            pos += 1
            continue
        chars.append(char)
        char_lines.append(line)
        pos += 1
    found, _ = line_statements("".join(chars), char_lines, line)
    if found:
        lines.append(found)
    return lines, False


def snapshot_state(state: BcState) -> BcState:
    """Copy the state a discarded line has to be rolled back to.

    GNU compiles a whole line and runs it only if all of it parsed, so a
    parse error anywhere on the line undoes every write the line made:
    `x=5;1 2` leaves `x` unset and `ibase=1;1 2` leaves `ibase` at ten.

    Args:
        state (BcState): the live state.

    Returns:
        BcState: a copy holding the registers and the symbol table. The
            warnings list is not copied, because a line's warnings are
            buffered by the caller rather than kept on the state.
    """
    return BcState(scale=state.scale,
                   math_mode=state.math_mode,
                   ibase=state.ibase,
                   obase=state.obase,
                   last=state.last,
                   variables=dict(state.variables))


def restore_state(state: BcState, saved: BcState) -> None:
    """Undo every write a discarded line made.

    Args:
        state (BcState): the live state, written in place because the
            parser holds a reference to it.
        saved (BcState): what `snapshot_state` recorded before the line.
    """
    state.scale = saved.scale
    state.ibase = saved.ibase
    state.obase = saved.obase
    state.last = saved.last
    state.variables = dict(saved.variables)


def error_line(statement: BcStatement, error: BcParseError) -> int:
    """The input line GNU charges a parse diagnostic to.

    Args:
        statement (BcStatement): the statement being parsed.
        error (BcParseError): the diagnostic.

    Returns:
        int: an incomplete construct is charged to the line its own
            terminator sits on; anything else to the line the offending
            character sits on.
    """
    if error.incomplete:
        return statement.incomplete_line
    if 0 <= error.pos < len(statement.lines):
        return statement.lines[error.pos]
    return statement.lines[0]


@command("bc", vfs=None, spec=SPECS["bc"], provision=pure_provision)
async def bc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["bc"])
    use_math = fl.as_bool("args_l")
    raw = await read_stdin_async(opts.stdin)
    if raw is None:
        raw = b""
    state = BcState(scale=MATH_LIBRARY_SCALE if use_math else 0,
                    math_mode=use_math)
    folder = OutputColumn(output_line_size(opts.env))
    results: list[str] = []
    errors: list[str] = []
    lines, eof_in_comment = parse_input(raw.decode(errors="replace"))
    halted = False
    for statements in lines:
        # GNU compiles one whole line and runs it at its newline, so a
        # parse error anywhere on the line means none of it ever ran: the
        # values, the runtime errors, the warnings and every write are
        # buffered here and thrown away if any statement refused to
        # parse. The parse diagnostics themselves are not buffered --
        # GNU reports one per bad statement even on a line it discards.
        saved = snapshot_state(state)
        saved_col = folder.col
        line_results: list[str] = []
        line_errors: list[str] = []
        parse_errors: list[str] = []
        # A runtime error is fatal to the rest of its own line and
        # non-fatal to every later one, so `1/0;2+2` prints nothing and
        # `1/0\n2+2\n` prints 4. It does not roll the line back the way
        # a parse error does: `x=5;1/0;y=7` leaves `x` at 5 and `y` unset.
        aborted = False
        for statement in statements:
            # A statement after a `halt`, after a runtime error, or on a
            # line a `quit` cut short is still parsed -- GNU compiles the
            # whole line before running any of it, which is where
            # `1+1;halt;1 2`'s syntax error comes from -- but never runs.
            runs = statement.execute and not halted and not aborted
            # A statement that does not run is parsed against a throwaway
            # copy, so it cannot write: GNU never executes it, and
            # `x=5;1/0;y=7` has to leave `y` unset while leaving `x` at 5.
            target = state if runs else snapshot_state(state)
            # Owned here rather than inside the parser, so that a runtime
            # error partway down a `print` list keeps the text already
            # written: `print "x", 1/0` writes the `x`.
            writes: list[str] = []
            try:
                eval_statement(statement.text, target, writes)
            except BcParseError as exc:
                parse_errors.append(
                    parse_error_line(error_line(statement, exc), exc.text))
            except BcRuntimeError as exc:
                # Reported unless the line turns out to be discarded,
                # which is why it is buffered: `1/0;2+2` reports the
                # division where `1/0;1 2` reports only the syntax error.
                if runs:
                    # Warnings the same statement already raised come
                    # first: `0^-1.5` warns about the exponent's scale
                    # and then refuses, in that order.
                    line_errors.extend(state.warnings)
                    state.warnings.clear()
                    line_errors.append(runtime_error_line(str(exc)))
                    aborted = True
            except BcHalt:
                # `halt` ends the run where it is reached, so everything
                # earlier on its line has already printed.
                halted = runs
            if runs:
                line_errors.extend(state.warnings)
            state.warnings.clear()
            if not runs:
                continue
            # The one place output is folded. Rendering happened as each
            # element was reached, in `Parser._emit`, because GNU's `obase`
            # and `last` can both change partway down a `print` list.
            for piece in writes:
                line_results.append(folder.write(piece))
        if parse_errors:
            # None of the line ran, so a `halt` on it did not run either,
            # and the column never moved: GNU compiles the line before it
            # writes anything, so a later statement's syntax error undoes
            # an earlier one's `print`.
            errors.extend(parse_errors)
            restore_state(state, saved)
            folder.col = saved_col
            halted = False
            continue
        errors.extend(line_errors)
        results.extend(line_results)
        if halted:
            break
    if eof_in_comment:
        errors.append(EOF_IN_COMMENT)
    stdout = "".join(results).encode()
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return stdout, IOResult(stderr=stderr)

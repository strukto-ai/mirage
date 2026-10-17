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

MATH_LIBRARY_SCALE = 20
MAX_SCALE = 100
DEFAULT_BASE = 10
MIN_BASE = 2
MAX_IBASE = 16
MAX_OBASE = 999
MAX_CHAR_BASE = 16
LINE_LENGTH_VAR = "BC_LINE_LENGTH"
DEFAULT_LINE_LENGTH = 70
MIN_LINE_LENGTH = 3
C_BLANKS = " \t\n\v\f\r"
C_LONG_BITS = 64
C_INT_BITS = 32
RUNTIME_ERROR_ADDR = 3
DIVIDE_BY_ZERO = "Divide by zero"
MODULO_BY_ZERO = "Modulo by zero"
POW_DIVIDE_BY_ZERO = "divide by zero"
IBASE_TOO_SMALL = "ibase too small, set to 2"
OBASE_TOO_SMALL = "obase too small, set to 2"
NEGATIVE_SCALE = "negative scale, set to 0"
NEGATIVE_SQRT = "Square root of a negative number"
NONZERO_EXPONENT_SCALE = "non-zero scale in exponent"
INPUT_NAME = "(standard_in)"
SYNTAX_ERROR = "syntax error"
ILLEGAL_CHARACTER = "illegal character"
EOF_IN_COMMENT = "EOF encountered in a comment."
LOG_NAME = "l"
SQRT_NAME = "sqrt"
LENGTH_NAME = "length"
HALT_NAME = "halt"
QUIT_NAME = "quit"
PRINT_NAME = "print"
SCALE_NAME = "scale"
IBASE_NAME = "ibase"
OBASE_NAME = "obase"
LAST_NAME = "last"
LAST_ALIAS = "."
REGISTERS = frozenset(
    {SCALE_NAME, IBASE_NAME, OBASE_NAME, LAST_NAME, LAST_ALIAS}
)
BUILTIN_CALLS = frozenset({SQRT_NAME, LENGTH_NAME, SCALE_NAME})
RESERVED_WORDS = frozenset(
    {
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
    }
)
BASE_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DECIMAL_DIGITS = frozenset("0123456789")
DIGIT_CHARS = frozenset(BASE_DIGITS)
NUMBER_CHARS = DIGIT_CHARS | {"."}
NAME_START = frozenset("abcdefghijklmnopqrstuvwxyz")
NAME_CHARS = NAME_START | DECIMAL_DIGITS | {"_"}
SYMBOL_CHARS = frozenset(".+-*/%^=<>!()[]{},;")
QUOTE_CHARS = frozenset('"\\# \t')
LEGAL_CHARS = DIGIT_CHARS | NAME_START | SYMBOL_CHARS | QUOTE_CHARS
COMPOUND_OPS = "+-*/%^"
BLANKS = frozenset(" \t")
STATEMENT_SEPARATOR = ";"
LINE_COMMENT = "#"
BLOCK_OPEN = "/*"
BLOCK_CLOSE = "*/"
STRING_QUOTE = '"'
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
TRIM_CHARS = " \t\r\v\f"
UTF8_TWO_BYTES = 0x80
UTF8_THREE_BYTES = 0x800
UTF8_FOUR_BYTES = 0x10000
MATH_FUNCS = frozenset({"s", "c", "a", "l", "e"})

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

export const MATH_LIBRARY_SCALE = 20
export const MAX_SCALE = 100
export const MAX_COEFFICIENT_BITS = 65536
export const MAX_LITERAL_DIGITS = 16000
export const MAX_WORKING_SCALE = 4096
export const DECIMAL_DIGIT_BITS = 4
export const SERIES_PRODUCT_FACTORS = 3
export const SERIES_LOOP_BITS = 128
export const DEFAULT_BASE = 10
export const MIN_BASE = 2
export const MAX_IBASE = 16
export const MAX_OBASE = 999
export const MAX_CHAR_BASE = 16
export const LINE_LENGTH_VAR = 'BC_LINE_LENGTH'
export const DEFAULT_LINE_LENGTH = 70
export const MIN_LINE_LENGTH = 3
export const C_BLANKS = ' \t\n\v\f\r'
export const C_LONG_BITS = 64n
export const C_INT_BITS = 32n

export const RUNTIME_ERROR_ADDR = 3

export const ARITHMETIC_LIMIT = 'Arithmetic limit exceeded'
export const DIVIDE_BY_ZERO = 'Divide by zero'
export const MODULO_BY_ZERO = 'Modulo by zero'
export const POW_DIVIDE_BY_ZERO = 'divide by zero'
export const IBASE_TOO_SMALL = 'ibase too small, set to 2'
export const OBASE_TOO_SMALL = 'obase too small, set to 2'
export const NEGATIVE_SCALE = 'negative scale, set to 0'
export const NEGATIVE_SQRT = 'Square root of a negative number'
export const NONZERO_EXPONENT_SCALE = 'non-zero scale in exponent'

export const INPUT_NAME = '(standard_in)'
export const SYNTAX_ERROR = 'syntax error'
export const ILLEGAL_CHARACTER = 'illegal character'
export const EOF_IN_COMMENT = 'EOF encountered in a comment.'
export const LOG_NAME = 'l'
export const SQRT_NAME = 'sqrt'
export const LENGTH_NAME = 'length'
export const HALT_NAME = 'halt'
export const QUIT_NAME = 'quit'
export const PRINT_NAME = 'print'
export const SCALE_NAME = 'scale'
export const IBASE_NAME = 'ibase'
export const OBASE_NAME = 'obase'
export const LAST_NAME = 'last'
export const LAST_ALIAS = '.'

export const REGISTERS = new Set([SCALE_NAME, IBASE_NAME, OBASE_NAME, LAST_NAME, LAST_ALIAS])

export const BUILTIN_CALLS = new Set([SQRT_NAME, LENGTH_NAME, SCALE_NAME])

export const RESERVED_WORDS = new Set([
  SCALE_NAME,
  IBASE_NAME,
  OBASE_NAME,
  LAST_NAME,
  SQRT_NAME,
  'length',
  'read',
  'define',
  'auto',
  'return',
  'if',
  'else',
  'while',
  'for',
  'break',
  'continue',
  'halt',
  'quit',
  'print',
  'limits',
  'warranty',
])

export const BASE_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const DECIMAL_DIGITS = new Set('0123456789')
export const DIGIT_CHARS = new Set(BASE_DIGITS)
export const NUMBER_CHARS = new Set([...DIGIT_CHARS, '.'])
export const NAME_START = new Set('abcdefghijklmnopqrstuvwxyz')
export const NAME_CHARS = new Set([...NAME_START, ...DECIMAL_DIGITS, '_'])
export const SYMBOL_CHARS = new Set('.+-*/%^=<>!()[]{},;')
export const QUOTE_CHARS = new Set('"\\# \t')
export const LEGAL_CHARS = new Set([...DIGIT_CHARS, ...NAME_START, ...SYMBOL_CHARS, ...QUOTE_CHARS])
export const COMPOUND_OPS = '+-*/%^'
export const BLANKS = new Set(' \t')
export const STATEMENT_SEPARATOR = ';'
export const LINE_COMMENT = '#'
export const BLOCK_OPEN = '/*'
export const BLOCK_CLOSE = '*/'
export const STRING_QUOTE = '"'
export const PRINT_ESCAPES = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['q', '"'],
  ['r', '\r'],
  ['t', '\t'],
  ['\\', '\\'],
])
export const TRIM_CHARS = ' \t\r\v\f'
export const MATH_FUNCS = new Set(['s', 'c', 'a', 'l', 'e'])
export const UTF8_TWO_BYTES = 0x80
export const UTF8_THREE_BYTES = 0x800
export const UTF8_FOUR_BYTES = 0x10000

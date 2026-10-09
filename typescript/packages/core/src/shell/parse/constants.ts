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

export const ARITH_OPEN_TOKEN = '(('

export const QUOTES: ReadonlySet<string> = new Set(["'", '"'])

// Nodes whose backslashes escape nothing, so a backslash-newline in one
// is text rather than a line continuation.
export const VERBATIM_TYPES: ReadonlySet<string> = new Set([
  'raw_string',
  'ansi_c_string',
  'comment',
])

export const BASH_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
])

// Tokens that make an ERROR node a real syntax error: brackets, quotes,
// and an expansion or substitution opener left unclosed, for which bash
// reads to the end of input looking for the match and runs none of the
// line.
export const STRUCTURAL_TOKENS: ReadonlySet<string> = new Set([
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '`',
  '$(',
  '$((',
  '${',
  '$[',
  '<(',
  '>(',
])

// Statement separators. One that lands inside an ERROR node has nothing
// to separate (a line starting with `;`, `| s`, `a ; ; b`, `a &; b`).
export const SEPARATOR_TOKENS: ReadonlySet<string> = new Set([';', '&', '|', '&&', '||'])

// The case-item terminators: a list ends at one only inside a case item.
export const CASE_TERMINATORS: ReadonlySet<string> = new Set([';;', ';&', ';;&'])

// The characters that end an unquoted word.
export const WORD_BREAKS: ReadonlySet<string> = new Set(' \t\n;&|()<>')

// Every operator bash reads, longest first, so the first one a line
// starts with is its token.
export const OPERATORS: readonly string[] = [
  ';;&',
  '&>>',
  '<<<',
  '<<-',
  ';;',
  ';&',
  '&&',
  '||',
  '|&',
  '&>',
  '<<',
  '>>',
  '<&',
  '>&',
  '<>',
  '>|',
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
]

// The characters operators are spelled with (the `-` of `<<-`).
export const OPERATOR_CHARS: ReadonlySet<string> = new Set(';&|<>()-')

export const REDIRECTIONS: ReadonlySet<string> = new Set([
  '<',
  '>',
  '>>',
  '<&',
  '>&',
  '<>',
  '>|',
  '&>',
  '&>>',
  '<<<',
  '<<',
  '<<-',
])

// The reserved words that close or continue a compound command. Spelled
// by an alias, one is a command where a command starts, except inside
// that alias's own text, where its name stays reserved.
export const CLOSING_WORDS: ReadonlySet<string> = new Set([
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'esac',
  '}',
  'in',
  ']]',
])

// Every reserved word. bash takes one as such only where a command starts
// (and after a compound command), never after a command's own words.
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  ...CLOSING_WORDS,
  'if',
  'case',
  'for',
  'select',
  'while',
  'until',
  'function',
  'time',
  '{',
  '!',
  '[[',
  'coproc',
])

// The reserved words opening a compound command: what a function body or
// a named coproc must start with.
export const COMPOUND_OPENERS: ReadonlySet<string> = new Set([
  '{',
  'if',
  'while',
  'until',
  'for',
  'select',
  'case',
  '[[',
])

// The builtins whose arguments read `name=(` as an array, as an
// assignment before a command does.
export const ARRAY_BUILTINS: ReadonlySet<string> = new Set([
  'alias',
  'declare',
  'eval',
  'export',
  'let',
  'local',
  'readonly',
  'typeset',
])

// The `[[ ]]` operators taking one operand, and those taking two (with
// `<` and `>`, which are operator tokens).
export const UNARY_TESTS: ReadonlySet<string> = new Set(
  '-a -b -c -d -e -f -g -h -k -p -r -s -t -u -w -x -G -L -N -O -S -z -n -o -v -R'.split(' '),
)
export const BINARY_TESTS: ReadonlySet<string> = new Set(
  '== = != =~ -eq -ne -lt -le -gt -ge -nt -ot -ef'.split(' '),
)

// The characters a shell name is spelled with; it cannot start with a
// digit.
export const NAME_START: ReadonlySet<string> = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_',
)
export const NAME_CHARS: ReadonlySet<string> = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_0123456789',
)

// The characters that open an extended pattern before `(`, which the
// right side of `==`, `=` and `!=` in `[[ ]]` reads with extglob on.
export const EXTGLOB_OPENERS: ReadonlySet<string> = new Set('@!+*?')

// bash's `syntax error near `X'` without "unexpected token" quotes the
// line back from where its reader stopped: to a blank, or to one of these,
// which it keeps.
export const NEAR_TEXT_STOPS: ReadonlySet<string> = new Set(';&|')

// How deep the syntax reader nests compound commands, substitutions and
// `[[ ]]` groups before it refuses a line at the next opener, as bash
// refuses a line nested past its own reader (thousands deep there).
export const MAX_NESTING = 64

// How the syntax reader takes the next token: whether `name=(` opens an
// array, `name[` reads a subscript up to its `]` across blanks, `((`
// opens arithmetic (and, where a command starts, is read again as two
// subshells when it does not close on its line), a leading `[` opens an
// array element's subscript, digits before `<` or `>` stay a word inside
// `[[ ]]`, an array in a function body reads reserved words as such, and
// the first array after a redirection reads an element's `name[` as a
// subscript.
export const READ_ARRAYS = 1
export const READ_SUBSCRIPTS = 2
export const READ_ARITH = 4
export const READ_START = 8
export const READ_ELEMENT = 16
export const READ_TEST = 32
export const READ_BODY = 64
export const READ_KEYS = 128
export const READ_PREFIX = READ_ARRAYS | READ_SUBSCRIPTS
export const READ_FOLLOW = READ_PREFIX | READ_ARITH
export const READ_COMMAND = READ_FOLLOW | READ_START

// Where a `variable_name` node is a write target rather than a read:
// the assignment's name and the for loop's variable. Everything else --
// expansions, arithmetic, subscripts -- reads the name.
export const TARGET_NAME_FIELDS: Record<string, string> = {
  variable_assignment: 'name',
  for_statement: 'variable',
}

// Nodes whose bare `variable_name` children declare or delete a name
// (`readonly R`, `export Z`, `unset X`); their assignment children still
// carry reads and are walked.
export const DECLARING_NODES: ReadonlySet<string> = new Set([
  'declaration_command',
  'unset_command',
])

// The declaring builtins whose bare invocation prints the environment
// (`export`, `export -p`, `declare`); `local` prints only a function's
// locals and `readonly` only the read-only set, neither of which a
// managed entry can be.
export const DECL_PRINTER_HEADS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset'])

// The declaring builtins whose `-n` makes the operand a nameref.
// `export -n` and `unset -n` mean other things and are not these.
export const NAMEREF_HEADS: ReadonlySet<string> = new Set(['declare', 'typeset', 'local'])

// Names a builtin reads with no `$NAME` in the text: `read` splits its
// input on `$IFS`; `getopts` resumes from `$OPTIND` and consults
// `$OPTERR` before printing a diagnostic. `cd`'s names depend on the
// operand shape (`cdReads`).
export const IMPLICIT_HEAD_READS: ReadonlyMap<string, readonly string[]> = new Map([
  ['read', ['IFS']],
  ['getopts', ['OPTIND', 'OPTERR']],
])

// A relative `cd` operand searches `$CDPATH` unless it is anchored
// (`/`, `./`, `../`) or a tilde the expansion anchors first; mirrors
// the cd builtin's search rule.
export const CD_ANCHORS = ['/', './', '../', '~']

// The `[[` comparators whose operands evaluate as arithmetic, so a
// bare word resolves as a variable and recurses through its value.
// `test`/`[` are absent on purpose: the flat builtin parses its
// integer operands strictly (`toInt`), bash's own split.
export const ARITH_TEST_OPERATORS: ReadonlySet<string> = new Set([
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
])

// A shell identifier, as the names a word reads are found.
export const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g

// The nodes whose text the respelling pass leaves to their own grammar:
// tests, arithmetic, strings, expansions, heredoc bodies and comments.
export const UNLEXED: ReadonlySet<string> = new Set([
  'test_command',
  'arithmetic_expansion',
  'string_content',
  'raw_string',
  'ansi_c_string',
  'expansion',
  'heredoc_content',
  'comment',
  'binary_expression',
  'unary_expression',
  'postfix_expression',
])

// The characters a word can start after, so a digit string there is a
// redirect's descriptor rather than the tail of a word.
export const WORD_START = ' \t\n;&|(){}'

// A run of digits at the respelling position.
export const DIGIT_RUN = /\d+/y

// A backslash before a blank, which escapes the blank into the word it opens.
export const ESCAPED_BLANK = /\\[ \t]/g

// What follows a case arm's terminator when the arm is the last one.
export const LAST_CASE_ARM = /^\s*esac(?![^\s;&|()<>])/

// Test operators the grammar lexes apart from a word in an argument list or
// an error region, where bash reads a word.
export const BARE_WORDS: ReadonlySet<string> = new Set(['==', '=~'])

// A `$` that no name, digit, special parameter, brace, paren, bracket or
// quote follows, which bash reads as a literal `$`.
export const LITERAL_DOLLAR = /\$(?![\w@*#?$!{(['"[-])/y

// The list and pipe operators, which end a `[` command's words.
export const LIST_TOKENS: ReadonlySet<string> = new Set(['&&', '||', '|', '|&', ';', '&', ';;'])

// The expression nodes a `[` test is built from, walked for a list operator
// the grammar folded into it.
export const TEST_PARTS: ReadonlySet<string> = new Set([
  'binary_expression',
  'unary_expression',
  'negation_expression',
  'parenthesized_expression',
  'ERROR',
])

// A for or select header's variable spelled as a name.
export const HEADER_NAME = /^\w+$/

// The `in` or `do` after a for or select header's variable.
export const HEADER_FOLLOWER = /^\s*(in|do)(?![^\s;&|()<>])/

// The nodes a newline between two children of cannot be whitespace, so a
// newline the grammar folded into one ends the statement.
export const STATEMENT_NODES: ReadonlySet<string> = new Set([
  'command',
  'declaration_command',
  'file_redirect',
  'redirected_statement',
  'unset_command',
])

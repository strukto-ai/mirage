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

// Each expansion or substitution opener: the token that closes it and the
// character bash's end-of-input diagnostic names for it.
export const OPENER_CLOSERS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['$(', [')', ')']],
  ['$((', ['))', ')']],
  ['<(', [')', ')']],
  ['>(', [')', ')']],
  ['${', ['}', '}']],
  ['$[', [']', ']']],
])

export const CLOSING_TOKENS: ReadonlySet<string> = new Set([')', '))', '}', ']'])

// The quotes an input can end inside; bash reads on looking for the match.
export const QUOTE_TOKENS: ReadonlySet<string> = new Set(["'", '"', '`'])

// The compound commands an ERROR can leave open, by the token closing
// each. Input ending inside one is bash's `syntax error: unexpected end
// of file`, not an unexpected token. A `(` after a command's words opens
// nothing: it is unexpected (`echo x (`) unless `()` defines a function.
export const COMPOUND_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['{', '}'],
  ['(', ')'],
  ['if', 'fi'],
  ['case', 'esac'],
  ['while', 'done'],
  ['until', 'done'],
  ['for', 'done'],
  ['select', 'done'],
])

// A construct the grammar leaves with a missing closer, by the character
// bash names when the input ends inside it. A subshell is absent: bash
// reports an unexpected end of file there instead.
export const CONSTRUCT_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['command_substitution', ')'],
  ['process_substitution', ')'],
  ['arithmetic_expansion', ')'],
  ['expansion', '}'],
  ['array', ')'],
])

// Statement separators. One that lands inside an ERROR node has nothing
// to separate (a line starting with `;`, `| s`, `a ; ; b`, `a &; b`), and
// bash refuses every such line with `syntax error near unexpected token`.
export const SEPARATOR_TOKENS: ReadonlySet<string> = new Set([';', '&', '|', '&&', '||'])

// The case-item terminators. The grammar also accepts them as plain
// statement separators, so `true;;s` parses without an ERROR node; bash
// only accepts them inside a case item.
export const CASE_TERMINATORS: ReadonlySet<string> = new Set([';;', ';&', ';;&'])

// Every list operator. Where a command or a word must come, one is the
// token bash reports as unexpected.
export const LIST_OPERATORS: ReadonlySet<string> = new Set([
  ...SEPARATOR_TOKENS,
  ...CASE_TERMINATORS,
  '|&',
])

// The tokens a command must follow (a keyword or operator that opens
// one) and those a word must follow (the subject of `case`, the name of
// `for`, `select` and `function`).
export const COMMAND_FOLLOWS: ReadonlySet<string> = new Set([
  'if',
  'elif',
  'while',
  'until',
  'then',
  'do',
  'else',
  '{',
  '(',
  '!',
  '|',
  '|&',
  '&&',
  '||',
])
export const NAME_FOLLOWS: ReadonlySet<string> = new Set(['case', 'for', 'select', 'function'])

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

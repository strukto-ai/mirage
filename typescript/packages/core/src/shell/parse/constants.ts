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

export const NAME_CONT = /[A-Za-z0-9_]/

export const DIGIT = /[0-9]/

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
])

// Statement separators. One that lands inside an ERROR node has nothing
// to separate (a line starting with `;`, `| s`, `a ; ; b`, `a &; b`), and
// bash refuses every such line with `syntax error near unexpected token`.
export const SEPARATOR_TOKENS: ReadonlySet<string> = new Set([';', '&', '|', '&&', '||'])

// The case-item terminators. The grammar also accepts them as plain
// statement separators, so `true;;s` parses without an ERROR node; bash
// only accepts them inside a case item.
export const CASE_TERMINATORS: ReadonlySet<string> = new Set([';;', ';&', ';;&'])

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

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

export const QUOTE_OPENERS: ReadonlySet<string> = new Set(["'", '"', '`'])

// `$(`, `<(` and `>(` open a substitution that runs to its balancing paren.
export const SUBSTITUTION_OPENERS: ReadonlySet<string> = new Set(['$', '<', '>'])

// A `#` opens a comment only where a word may start: after a blank or a
// metacharacter, never inside a word (`a#b`, `$#`).
export const COMMENT_PRECEDERS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  ';',
  '|',
  '&',
  '(',
  ')',
  '<',
  '>',
])

// What a command may follow, so where `case` and `esac` are reserved
// words rather than ordinary ones (`grep case f` names a file).
export const COMMAND_PRECEDERS: ReadonlySet<string> = new Set(['\n', ';', '|', '&', '(', ')'])

// What still opens a quote inside an expanding one: a backtick takes
// both quotes and a double quote takes a backtick, while a `'` inside
// double quotes is an ordinary character (`"it's"` is one word).
export const NESTED_QUOTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['"', new Set(['`'])],
  ['`', new Set(["'", '"'])],
])

export const CASE = 'case'
export const ESAC = 'esac'

// Characters the heredoc scanner skips at the start of the body's first line.
export const LINE_BLANKS: ReadonlySet<string> = new Set([' ', '\t', '\r'])

// Characters a body may open with that never reach the scanner as body text.
export const SKIPPED_BLANKS: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n'])

// What a backslash escapes in an unquoted body (`\$`, `` \` ``, `\\`).
export const ESCAPE_PARTNERS: ReadonlySet<string> = new Set(['$', '`', '\\'])

// What a backslash escapes inside a double-quoted word; before any other
// character it stays literal, so `"E\xF"` names E\xF.
export const DQUOTE_ESCAPABLE: ReadonlySet<string> = new Set(['$', '`', '"', '\\'])

// The letter written over a masked character, and the one used instead
// when the delimiter itself starts with it.
export const FILLER = 'x'
export const ALTERNATE_FILLER = 'y'

export const HEREDOC_START = 'heredoc_start'
export const HEREDOC_BODY = 'heredoc_body'
export const DASH_ARROW = '<<-'

// Bash's metacharacters other than blanks: what ends an unquoted word, so
// where tree-sitter's delimiter token has run past the delimiter (`EOF;`
// is the word `EOF` and then a `;`).
export const WORD_BREAKERS: ReadonlySet<string> = new Set(['|', '&', ';', '(', ')', '<', '>'])

// The statement terminators an operator line keeps as bash reads them at
// the start of a line, longest first so `;;&` is not read as `;;` and an
// `&`. A lone `;` is not among them: bash refuses a line opening with one,
// so the newline that precedes the moved body stands in for it.
export const KEPT_TERMINATORS: readonly string[] = [';;&', ';;', ';&', ')']

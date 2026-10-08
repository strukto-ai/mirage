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

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// A number as bash's builtins read one: strtoimax's leading whitespace and
// sign, then the trailing blanks bash skips itself.
export const COUNT_WORD_RE = /^[ \t\n\v\f\r]*[+-]?[0-9]+[ \t]*$/

// An assignment target with an optional subscript (`name` or `name[sub]`).
// A subscript must be non-empty: bash rejects `a[]` as an invalid
// identifier, while `a[ ]` is a valid arithmetic 0.
export const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.+)\])?$/

// What makes bash's bare `set` single-quote a value: IFS whitespace,
// quoting and control characters, reserved-word and glob characters, and
// the expansion introducers (`$` and a backquote). A `~` counts at
// the start or after `=` or `:`, and a `#` only at the start.
export const SET_QUOTED_CHARS: ReadonlySet<string> = new Set(' \t\n\'"\\|&;()<>!{}*[?]^$`')

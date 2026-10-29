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

export const DESCRIPTION = 'A composable, scriptable and durable virtual terminal for AI agents.'

// The listing's lead, after the version line and the description.
export const GUIDE: readonly string[] = [
  "These commands are built into the shell; `help NAME' shows how to use one.",
  "Every other command describes itself with `NAME --help' or `man NAME'.",
  '',
  'A star (*) next to a name means that this session may not run it.',
]

// Width of a listing whose $COLUMNS is unset or too small to use, the
// smallest one it takes, and the widest a column grows.
export const DEFAULT_COLUMNS = 80
export const MIN_COLUMNS = 8
export const MAX_CELL = 128

// Width the descriptions wrap to, their indent included.
export const TEXT_WIDTH = 80

// Builtins whose first word `--help' is an operand like any other, as in
// bash: they take no options, or print their arguments.
export const OPERAND_HELP: ReadonlySet<string> = new Set([
  ':',
  '[',
  'echo',
  'false',
  'test',
  'true',
])

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

export interface BashArgs {
  // Inline program text from `-c`.
  script: string | null
  // Script file operand, as typed.
  path: string | null
  // Words after the program: `$0` first for the `-c` form, all
  // positional for the other two.
  argv: string[]
  // Shell options the startup flags turn on or off, in the order written.
  settings: [string, boolean][]
  // The option the shell refuses, as bash names it.
  invalid: string | null
  // The option given no argument.
  needsValue: string | null
  // `--help` was given; bash answers it before `--version` and before
  // reading anything else.
  help: boolean
  // `--version` was given.
  version: boolean
}

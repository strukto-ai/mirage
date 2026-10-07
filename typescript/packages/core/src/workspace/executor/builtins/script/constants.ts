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

import { specOf } from '../../../../commands/spec/index.ts'
import { SET_OPTION_NAMES } from '../../../../shell/constants.ts'
import { BashLongOption } from './types.ts'

// Startup letters bash has that `set` does not. `c` takes the program text
// from the next word and `s` reads it from stdin; the rest have nothing to
// configure in an embedded shell, which has no login profile, no rc file and
// no tty. Letters that name a `set` option (-e -u -x -f) are not here:
// parseOptionWord already knows them, so the two spellings cannot drift.
export const BASH_START_FLAGS = new Set(['c', 's', 'l', 'i'])

// bash 5.2's long options (`long_args` in shell.c, the list `bash --help`
// prints), by name. bash reads them only before the first short option, a
// word at a time, with one dash or two: `bash -norc` is `bash --norc`. The
// ones the spec lists come from it, so the help page and the parser cannot
// drift: a value option swallows the next word, so `bash --rcfile run.sh` is
// not "run run.sh", and one named like a `set -o` option sets it. The ones
// that change what bash does to its input (restricted mode, the string
// dumps, pretty-printing, the debugger) are refused rather than silently
// ignored.
export const BASH_LONG_OPTIONS: Readonly<Record<string, BashLongOption>> = Object.freeze({
  ...Object.fromEntries(
    specOf('bash').options.flatMap(({ long, type }): [string, BashLongOption][] => {
      if (long === null) return []
      const name = long.slice(2)
      if (type === 'str') return [[name, BashLongOption.VALUE]]
      return [[name, SET_OPTION_NAMES.has(name) ? BashLongOption.SETTING : BashLongOption.IGNORE]]
    }),
  ),
  debugger: BashLongOption.UNSUPPORTED,
  'dump-po-strings': BashLongOption.UNSUPPORTED,
  'dump-strings': BashLongOption.UNSUPPORTED,
  help: BashLongOption.HELP,
  'pretty-print': BashLongOption.UNSUPPORTED,
  restricted: BashLongOption.UNSUPPORTED,
  version: BashLongOption.VERSION,
})

// GNU prints the refusal and the usage line together, both under the
// builtin's own name as typed (`source` or `.`), and exits 2 without ending
// the script.
export const SOURCE_USAGE = 'filename argument required\n{name}: usage: {name} filename [arguments]'

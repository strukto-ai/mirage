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

import { expandTableLong } from '../../../spec/compile.ts'
import { TAR_LONG_OPTIONS } from '../../../spec/constants.ts'

const VALUE_LETTERS = 'bCfFgGHIKLNTVX'

// Whether an option cluster holds c, r or u, reading no further than a letter
// whose value is the rest of the word. Mirrors Python's `_names_a_source_mode`.
function namesASourceMode(cluster: string): boolean {
  for (const letter of cluster) {
    if ('cru'.includes(letter)) return true
    if (VALUE_LETTERS.includes(letter)) return false
  }
  return false
}

/**
 * Whether a tar line reads the filesystem rather than an archive.
 *
 * -c, -r and -u make tar's operands source paths. Under -t, -x and
 * --delete they are member selectors matched against names inside the archive, so a
 * selector that happens to spell a mount root is not a mount at all and
 * refusing it would deny an ordinary listing.
 *
 * Scanned raw because both callers fire before flag parsing: the
 * mount-root policy at admission, and the cross-mount router deciding
 * whether a span is real. Only the first word may be GNU's dashless
 * option cluster (`tar cf a.tar d`), so a later bare word is an operand
 * and cannot turn the mode on. `--` ends the scan the way it ends GNU's
 * option parsing: a later `-c` names a member, and reading it as the
 * create flag would refuse the very selector fix this gate exists to
 * protect (`tar -xf a.tar -C /dst -- -c`). A long word is read the way
 * tar's getopt_long reads it, against tar's whole table, so an abbreviation
 * (`--crea`) is create too.
 */
export function isCreateMode(argv: readonly string[]): boolean {
  for (const [i, tok] of argv.entries()) {
    if (tok === '--') return false
    if (tok.startsWith('--')) {
      const found = expandTableLong(TAR_LONG_OPTIONS, tok.split('=', 1)[0] ?? tok)
      if (found.length === 1 && ['--create', '--append', '--update'].includes(found[0] ?? ''))
        return true
      continue
    }
    if (tok.startsWith('-')) {
      if (namesASourceMode(tok.slice(1))) return true
      continue
    }
    if (i === 0 && namesASourceMode(tok)) return true
  }
  return false
}

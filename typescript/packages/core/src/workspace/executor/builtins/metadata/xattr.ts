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

import { type ParsedArgs } from '../../../../commands/spec/parser.ts'
import {
  ambiguousOptionError,
  missingValueError,
  unexpectedValueError,
  unknownOptionError,
} from '../../../../commands/spec/usage.ts'
import { classify } from '../../../../errors/index.ts'
import { POSIX } from '../../../../errors/posix.ts'
import { PathSpec } from '../../../../types.ts'
import { result } from '../shared.ts'
import type { Result } from '../types.ts'

// attr 2.5.2's usage blocks, which follow getopt's one-line refusal and
// end every usage error (exit 2) with the older backquote hint.
export const GETFATTR_USAGE =
  'Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...\n' +
  "Try `getfattr --help' for more information.\n"
export const SETFATTR_USAGE =
  'Usage: setfattr {-n name} [-v value] [-h] file...\n' +
  '       setfattr {-x name} [-h] file...\n' +
  "Try `setfattr --help' for more information.\n"

/**
 * The usage error attr prints for a line getopt refused, if any: getopt's
 * own line (`invalid option -- 'Z'`, `option requires an argument --
 * 'n'`) and then attr's usage block, exit 2. Mirrors Python's
 * `attr_usage_refusal`.
 */
export function attrUsageRefusal(cmd: string, parsed: ParsedArgs, usage: string): Result | null {
  let message: Uint8Array | null = null
  const ambiguous = parsed.ambiguousOptions[0]
  const invalid = parsed.invalidOptions[0]
  const needsValue = parsed.needsValueOptions[0]
  if (
    ambiguous !== undefined &&
    (invalid === undefined || parsed.optionErrorKinds[0] === 'ambiguous')
  ) {
    ;[message] = ambiguousOptionError(cmd, ...ambiguous)
  } else if (invalid !== undefined) {
    ;[message] =
      parsed.optionErrorKinds[0] === 'unexpected_value'
        ? unexpectedValueError(cmd, invalid)
        : unknownOptionError(cmd, invalid)
  } else if (needsValue !== undefined) {
    ;[message] = missingValueError(cmd, needsValue)
  }
  if (message === null) return null
  const line = new TextDecoder().decode(message).split('\n', 1)[0] ?? ''
  return result(cmd, { exitCode: 2, stderr: `${line}\n${usage}` })
}

/**
 * The phrase attr prints for a failed attribute call: "No such
 * attribute" for one that is not set, whatever the platform calls it,
 * and the C library's wording for everything else. Mirrors Python's
 * `attr_error`.
 */
export function attrError(err: unknown): string {
  const condition = classify(err)
  if (condition === 'NO_XATTR') return 'No such attribute'
  if (condition !== null) return POSIX[condition].phrase
  return err instanceof Error ? err.message : String(err)
}

/**
 * The line's file operands, resolved against the session's cwd, each
 * keeping the spelling it was typed with for the header and messages.
 * Mirrors Python's `attr_operands`.
 */
export function attrOperands(parsed: ParsedArgs): PathSpec[] {
  const typed = parsed.rawOperands
  return parsed.args.map(([path], i) => {
    const spec = PathSpec.fromStrPath(path)
    return new PathSpec({
      virtual: spec.virtual,
      directory: spec.directory,
      vfsPath: spec.vfsPath,
      rawPath: typed[i]?.[0] ?? path,
    })
  })
}

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

import { parseCommand, parseToKwargs } from '../../../commands/spec/parser.ts'
import {
  ambiguousOptionError,
  invalidArgumentError,
  invalidFloatError,
  invalidIntError,
  missingRequiredError,
  missingValueError,
  oldOptionError,
  unknownOptionError,
} from '../../../commands/spec/usage.ts'
import type { CommandSpec, FlagValue } from '../../../commands/spec/types.ts'
import { PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// Single-mount dispatch and cross-mount dispatch both parse through here,
// so flags, texts, and parser warnings cannot drift between the two paths
// (a cross-mount `grep --bogus` used to lose its warning). The spec comes
// from the owning mount on the single-mount path and the shared SPECS
// registry on the cross-mount path.
/**
 * A PathSpec for a path the classifier never saw: a relative value
 * cwd-resolved by `parseCommand`, or a spec-classified PATH operand the
 * upstream classifier left as text. `resourcePath` stays empty on
 * purpose: the mount stamps the backend key on every path at execute
 * time (`Mount.executeCmd`), so a parse-time stamp is dead weight —
 * proven in both languages by running the full suite with this field
 * set to a sentinel. Mirrors `synthesize_path_spec` in the Python
 * executor.
 */
function synthesizePathSpec(value: string): PathSpec {
  const slash = value.lastIndexOf('/')
  return new PathSpec({
    resourcePath: '',
    virtual: value,
    directory: slash >= 0 ? value.slice(0, slash + 1) : '/',
    resolved: true,
  })
}

export function parseFlags(
  parts: readonly (string | PathSpec)[],
  spec: CommandSpec | null,
  cmdName: string,
  cwd: string,
): [
  PathSpec[],
  string[],
  Record<string, FlagValue>,
  string[],
  string[],
  [string, readonly string[]][],
  string[],
  string[],
  [string, string, readonly string[]][],
  [string, string][],
  [string, string][],
  string[],
  string | null,
  string[],
  string[],
] {
  const argv: string[] = parts.map((item) => (item instanceof PathSpec ? item.virtual : item))
  const scopeMap = new Map<string, PathSpec>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      scopeMap.set(item.virtual, item)
      const stripped = rstripSlash(item.virtual)
      if (stripped !== '' && stripped !== item.virtual) scopeMap.set(stripped, item)
    }
  }

  if (spec !== null) {
    const parsed = parseCommand(spec, argv, cwd)
    const flagKwargs = parseToKwargs(parsed)

    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) {
          flagKwargs[key] = match.virtual
        }
      }
    }

    const paths: PathSpec[] = []
    const texts: string[] = []
    for (const [value, kind] of parsed.args) {
      if (kind === 'path') {
        const existing = scopeMap.get(value)
        paths.push(existing ?? synthesizePathSpec(value))
      } else {
        texts.push(value)
      }
    }
    return [
      paths,
      texts,
      flagKwargs,
      parsed.warnings,
      parsed.invalidOptions,
      parsed.ambiguousOptions,
      parsed.optionErrorKinds,
      parsed.needsValueOptions,
      parsed.invalidValueOptions,
      parsed.invalidIntOptions,
      parsed.invalidFloatOptions,
      parsed.missingRequiredOptions,
      parsed.oldOptionNeedsValue,
      parsed.missingRequiredOperands,
      parsed.typedDests,
    ]
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return [paths, texts, {}, [], [], [], [], [], [], [], [], [], null, [], []]
}

// GNU-shaped refusal for option errors the parser reported. find is
// exempt: its expression tokens are validated by parseFindExpression,
// which raises the GNU predicate error itself.
export function optionError(
  cmdName: string,
  invalid: readonly string[],
  ambiguous: readonly [string, readonly string[]][],
  errorKinds: readonly string[],
  needsValue: readonly string[],
  invalidValue: readonly [string, string, readonly string[]][],
  invalidInt: readonly [string, string][],
  invalidFloat: readonly [string, string][],
  missingRequired: readonly string[],
  oldOptionNeedsValue: string | null = null,
): [Uint8Array, number] | null {
  if (cmdName === 'find') return null
  // An old-style cluster short of an argument outranks every scan error
  // below: tar counts the cluster's needs before argp validates a letter,
  // so `tar Qf` and `tar fQ` both name f, not Q.
  if (oldOptionNeedsValue !== null) return oldOptionError(cmdName, oldOptionNeedsValue)
  // Scan-order between unknown and ambiguous options: GNU stops at the
  // first offending token, so `grep --c --bogus` reports the ambiguity
  // and the reversed line reports --bogus.
  const ambiguousFirst = ambiguous[0]
  if (errorKinds[0] === 'ambiguous' && ambiguousFirst !== undefined) {
    return ambiguousOptionError(cmdName, ...ambiguousFirst)
  }
  if (invalid.length > 0) return unknownOptionError(cmdName, invalid[0] ?? '')
  if (ambiguousFirst !== undefined) return ambiguousOptionError(cmdName, ...ambiguousFirst)
  if (needsValue.length > 0) return missingValueError(cmdName, needsValue[0] ?? '')
  // Numeric-typed values before choices, argparse's order (choices are
  // checked against the converted value), matching the walk's finishNode:
  // a non-numeric value on an int/float option that also declares choices
  // reports the conversion failure, not the choice list.
  const badInt = invalidInt[0]
  if (badInt !== undefined) return invalidIntError(cmdName, ...badInt)
  const badFloat = invalidFloat[0]
  if (badFloat !== undefined) return invalidFloatError(cmdName, ...badFloat)
  const badValue = invalidValue[0]
  if (badValue !== undefined) return invalidArgumentError(cmdName, ...badValue)
  if (missingRequired.length > 0) return missingRequiredError(cmdName, missingRequired[0] ?? '')
  return null
}

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
  invalidArgumentError,
  missingRequiredError,
  missingValueError,
  unknownOptionError,
} from '../../../commands/spec/usage.ts'
import { OperandKind } from '../../../commands/spec/types.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
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
  Record<string, string | boolean | number | string[]>,
  string[],
  string[],
  string[],
  [string, string, readonly string[]][],
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
      if (kind === OperandKind.PATH) {
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
      parsed.needsValueOptions,
      parsed.invalidValueOptions,
      parsed.missingRequiredOptions,
    ]
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return [paths, texts, {}, [], [], [], [], []]
}

// GNU-shaped refusal for option errors the parser reported. find is
// exempt: its expression tokens are validated by parseFindExpression,
// which raises the GNU predicate error itself.
export function optionError(
  cmdName: string,
  invalid: readonly string[],
  needsValue: readonly string[],
  invalidValue: readonly [string, string, readonly string[]][],
  missingRequired: readonly string[],
): [Uint8Array, number] | null {
  if (cmdName === 'find') return null
  if (invalid.length > 0) return unknownOptionError(cmdName, invalid[0] ?? '')
  if (needsValue.length > 0) return missingValueError(cmdName, needsValue[0] ?? '')
  const badValue = invalidValue[0]
  if (badValue !== undefined) return invalidArgumentError(cmdName, ...badValue)
  if (missingRequired.length > 0) return missingRequiredError(cmdName, missingRequired[0] ?? '')
  return null
}

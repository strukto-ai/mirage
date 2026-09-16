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
  unexpectedValueError,
  unknownOptionError,
} from '../../../commands/spec/usage.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
import type { ParsedCommand } from './types.ts'
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

/**
 * The next classified word spelling `value`, in argv order. Two words can
 * resolve to one path (`ls -d dir/ link/` with link -> dir, `tar -C dir .`),
 * each with its own spelling, so every consumer takes the next word for
 * its path off a queue rather than reading a lookup keyed by the path
 * alone, which handed them all the last spelling; the parser hands
 * positionals back in argv order, the guarantee argparse gives too. A path
 * no word spells (one the parser normalized, a followed link whose target
 * climbs through `..`) falls back to the map, which still serves a word
 * the classifier left as text, and is synthesized after that, since a
 * keyed backend cannot read `b/../a`. Mirrors `take_spelling`.
 */
function takeSpelling(
  spellings: Map<string, PathSpec[]>,
  scopeMap: Map<string, PathSpec>,
  value: string,
): PathSpec {
  const taken = spellings.get(rstripSlash(value) || '/')?.shift()
  if (taken !== undefined) return taken
  return scopeMap.get(value) ?? synthesizePathSpec(value)
}

export function parseFlags(
  parts: readonly (string | PathSpec)[],
  spec: CommandSpec | null,
  cmdName: string,
  cwd: string,
  // The session environment, so an option declaring one gets its value
  // from there. Filled inside the parse rather than after it, or an
  // env-supplied int would go unchecked and an env-supplied path would
  // stay a bare string.
  env?: Readonly<Record<string, string>>,
): ParsedCommand {
  const argv: string[] = parts.map((item) => (item instanceof PathSpec ? item.virtual : item))
  const scopeMap = new Map<string, PathSpec>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      scopeMap.set(item.virtual, item)
      const stripped = rstripSlash(item.virtual)
      if (stripped !== '' && stripped !== item.virtual) scopeMap.set(stripped, item)
    }
  }
  const spellings = new Map<string, PathSpec[]>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      const key = rstripSlash(item.virtual) || '/'
      const queue = spellings.get(key)
      if (queue === undefined) spellings.set(key, [item])
      else queue.push(item)
    }
  }

  if (spec !== null) {
    const parsed = parseCommand(spec, argv, cwd, env)
    const flagKwargs = parseToKwargs(parsed)

    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) {
          flagKwargs[key] = match.virtual
        }
      }
    }
    // An option's value is read before the operands, which is POSIX order
    // and the order -C requires (its value moves the operands after it),
    // so `tar -cf out.tar -C dir .` hands `dir` to -C and `.` to the
    // operand. A flag value stays a string here, so its word only leaves
    // the queue. A permuted line spelling one path twice, once as an
    // option's value typed after the operand, swaps the two spellings and
    // nothing else.
    for (const value of parsed.pathFlagValues) takeSpelling(spellings, scopeMap, value)

    // Classify positional args: each operand takes its own word.
    const paths: PathSpec[] = []
    const texts: string[] = []
    for (const [value, kind] of parsed.args) {
      if (kind === 'path') {
        paths.push(takeSpelling(spellings, scopeMap, value))
      } else {
        texts.push(value)
      }
    }
    return {
      paths,
      texts,
      flagKwargs,
      warnings: parsed.warnings,
      invalidOptions: parsed.invalidOptions,
      ambiguousOptions: parsed.ambiguousOptions,
      optionErrorKinds: parsed.optionErrorKinds,
      needsValueOptions: parsed.needsValueOptions,
      invalidValueOptions: parsed.invalidValueOptions,
      invalidIntOptions: parsed.invalidIntOptions,
      invalidFloatOptions: parsed.invalidFloatOptions,
      missingRequiredOptions: parsed.missingRequiredOptions,
      oldOptionNeedsValue: parsed.oldOptionNeedsValue,
      missingRequiredOperands: parsed.missingRequiredOperands,
      typedDests: parsed.typedDests,
    }
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return {
    paths,
    texts,
    flagKwargs: {},
    warnings: [],
    invalidOptions: [],
    ambiguousOptions: [],
    optionErrorKinds: [],
    needsValueOptions: [],
    invalidValueOptions: [],
    invalidIntOptions: [],
    invalidFloatOptions: [],
    missingRequiredOptions: [],
    oldOptionNeedsValue: null,
    missingRequiredOperands: [],
    typedDests: [],
  }
}

// GNU-shaped refusal for option errors the parser reported. find is
// exempt: its expression tokens are validated by parseFindExpression,
// which raises the GNU predicate error itself. Takes the whole
// ParsedCommand, mirroring Python's `option_error(cmd_name, parsed)`.
export function optionError(cmdName: string, parsed: ParsedCommand): [Uint8Array, number] | null {
  if (cmdName === 'find') return null
  // An old-style cluster short of an argument outranks every scan error
  // below: tar counts the cluster's needs before argp validates a letter,
  // so `tar Qf` and `tar fQ` both name f, not Q.
  if (parsed.oldOptionNeedsValue !== null) {
    return oldOptionError(cmdName, parsed.oldOptionNeedsValue)
  }
  // Scan-order between unknown and ambiguous options: GNU stops at the
  // first offending token, so `grep --c --bogus` reports the ambiguity
  // and the reversed line reports --bogus.
  const ambiguousFirst = parsed.ambiguousOptions[0]
  if (parsed.optionErrorKinds[0] === 'ambiguous' && ambiguousFirst !== undefined) {
    return ambiguousOptionError(cmdName, ...ambiguousFirst)
  }
  if (parsed.invalidOptions.length > 0) {
    // Two reports share invalidOptions and the tag tells them apart: a
    // boolean long handed a value is not an unrecognized option, and
    // getopt_long words it differently (`grep --byte-offset=2`).
    if (parsed.optionErrorKinds[0] === 'unexpected_value') {
      return unexpectedValueError(cmdName, parsed.invalidOptions[0] ?? '')
    }
    return unknownOptionError(cmdName, parsed.invalidOptions[0] ?? '')
  }
  if (ambiguousFirst !== undefined) return ambiguousOptionError(cmdName, ...ambiguousFirst)
  if (parsed.needsValueOptions.length > 0) {
    return missingValueError(cmdName, parsed.needsValueOptions[0] ?? '')
  }
  // Numeric-typed values before choices, argparse's order (choices are
  // checked against the converted value), matching the walk's finishNode:
  // a non-numeric value on an int/float option that also declares choices
  // reports the conversion failure, not the choice list.
  const badInt = parsed.invalidIntOptions[0]
  if (badInt !== undefined) return invalidIntError(cmdName, ...badInt)
  const badFloat = parsed.invalidFloatOptions[0]
  if (badFloat !== undefined) return invalidFloatError(cmdName, ...badFloat)
  const badValue = parsed.invalidValueOptions[0]
  if (badValue !== undefined) return invalidArgumentError(cmdName, ...badValue)
  if (parsed.missingRequiredOptions.length > 0) {
    return missingRequiredError(cmdName, parsed.missingRequiredOptions[0] ?? '')
  }
  return null
}

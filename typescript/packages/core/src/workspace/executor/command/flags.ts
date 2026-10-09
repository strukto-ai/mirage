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

import { compileSpec } from '../../../commands/spec/compile.ts'
import { flagKwargName } from '../../../commands/spec/constants.ts'
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
import type { CommandSpec, FlagValue } from '../../../commands/spec/types.ts'
import type { ParsedCommand } from './types.ts'
import { PathSpec } from '../../../types.ts'
import { dottedSpelling, resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// Single-mount dispatch and cross-mount dispatch both parse through here,
// so flags, texts, and parser warnings cannot drift between the two paths
// (a cross-mount `grep --bogus` used to lose its warning). The spec comes
// from the owning mount on the single-mount path and the shared SPECS
// registry on the cross-mount path.
/**
 * A PathSpec for a path the classifier never saw: a relative value
 * cwd-resolved by `parseCommand`, or a spec-classified PATH operand the
 * upstream classifier left as text. `vfsPath` stays empty on
 * purpose: the mount stamps the backend key on every path at execute
 * time (`Mount.runCommand`), so a parse-time stamp is dead weight —
 * proven in both languages by running the full suite with this field
 * set to a sentinel. The empty name, which only an attached value can
 * spell (`--file=`), names nothing, however it resolved: its walk answers
 * ENOENT, as a typed '' operand's does. Mirrors `synthesize_path_spec` in
 * the Python executor.
 */
function synthesizePathSpec(value: string, rawPath = value, cwd = '/'): PathSpec {
  const slash = value.lastIndexOf('/')
  return new PathSpec({
    vfsPath: '',
    virtual: value,
    rawPath,
    directory: slash >= 0 ? value.slice(0, slash + 1) : '/',
    resolved: true,
    dotted: resolvePath(rawPath, cwd) === value ? dottedSpelling(rawPath, cwd) : null,
    walkError: rawPath === '' ? 'ENOENT' : null,
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
  rawPath?: string,
  cwd = '/',
): PathSpec {
  const taken = spellings.get(rstripSlash(value) || '/')?.shift()
  if (taken !== undefined) return taken
  return scopeMap.get(value) ?? synthesizePathSpec(value, rawPath, cwd)
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
  // Whether another parser reads this line after mirage, passed straight to
  // parseCommand. True only for an installed CLI's node, whose spec is
  // deliberately partial.
  unknownIsOperand = false,
  // The program's own long-option table, when it resolves abbreviations
  // against it (git's parse-options), passed straight to parseCommand.
  abbreviations?: readonly string[],
): ParsedCommand {
  const argv: string[] = parts.map((item) =>
    item instanceof PathSpec ? (item.rawPath === '-' ? '-' : item.virtual) : item,
  )
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
    const parsed = parseCommand(spec, argv, cwd, cmdName, env, unknownIsOperand, abbreviations)
    // Widens from ParsedFlagValue to FlagValue: PATH values become PathSpec
    // just below.
    const flagKwargs: Record<string, FlagValue> = parseToKwargs(parsed)

    // Recover PathSpec for PATH flag values, each the word that spelled it,
    // so an error line names the path as typed; a relative value
    // cwd-resolved by parseCommand (csplit -f part -> /data/part) is
    // absent from scopeMap and is synthesized like a positional. A pair
    // option's list alternates name, value; only the values are paths (jq
    // --rawfile body /d/f.txt). An option's value is read before the
    // operands, which is POSIX order and the order -C requires (its value
    // moves the operands after it), so `tar -cf out.tar -C dir .` hands
    // `dir` to -C and `.` to the operand. A permuted line spelling one
    // path twice, once as an option's value typed after the operand, swaps
    // the two spellings and nothing else. Mirrors Python's parse_flags.
    const pathKeys = new Map<string, 'single' | 'multiple' | 'pair'>()
    for (const opt of compileSpec(spec).options) {
      if (opt.type !== 'path') continue
      const shape = opt.valueTypes.includes('path')
        ? 'pair'
        : opt.action === 'append' || opt.action === 'extend' || typeof opt.nargs === 'number'
          ? 'multiple'
          : 'single'
      for (const name of opt.names) {
        pathKeys.set(flagKwargName(name), shape)
      }
    }
    for (const [key, value] of Object.entries(flagKwargs)) {
      const shape = pathKeys.get(key)
      const raw = parsed.rawPathFlags[key]
      const rawParts = Array.isArray(raw) ? raw : []
      const parts: readonly (string | PathSpec)[] = Array.isArray(value) ? value : []
      if (shape === 'pair' && Array.isArray(value)) {
        flagKwargs[key] = parts.map((part, index) =>
          index % 2 === 1 && typeof part === 'string'
            ? takeSpelling(spellings, scopeMap, part, rawParts[index], cwd)
            : part,
        )
      } else if (shape === 'multiple' && Array.isArray(value)) {
        flagKwargs[key] = parts
          .filter((part): part is string => typeof part === 'string')
          .map((part, index) => takeSpelling(spellings, scopeMap, part, rawParts[index], cwd))
      } else if (shape === 'single' && typeof value === 'string') {
        flagKwargs[key] = takeSpelling(
          spellings,
          scopeMap,
          value,
          typeof raw === 'string' ? raw : undefined,
          cwd,
        )
      }
    }
    // Every value still a string is text, with a classified word's path in
    // place of its spelling.
    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) flagKwargs[key] = match.virtual
      }
    }

    // Classify positional args: each operand takes its own word. The
    // spelling rides along for a word the classifier left as text (an
    // interpreter's bare script name under the shell's word policy), so
    // the handler still sees it as typed: CPython puts the operand
    // itself in argv[0].
    const paths: PathSpec[] = []
    const texts: string[] = []
    parsed.args.forEach(([value, kind], index) => {
      if (kind === 'path') {
        paths.push(takeSpelling(spellings, scopeMap, value, parsed.rawOperands[index]?.[0], cwd))
      } else {
        texts.push(value)
      }
    })
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
      ambiguousValueOptions: parsed.ambiguousValueOptions,
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
    ambiguousValueOptions: [],
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
  // The first refusal on the line, whichever check made it: GNU stops at
  // the first offending token, so `grep --c --bogus` reports the
  // ambiguity, the reversed line reports --bogus, and `numfmt --from=bad
  // --bogus` reports the value. The kinds tape holds one tag per refusal
  // in scan order and each list is in scan order too, so the first tag's
  // detail is the head of that tag's list. "invalid" and
  // "unexpected_value" share invalidOptions: a boolean long handed a value
  // is not an unrecognized option, and getopt_long words it differently
  // (`grep --byte-offset=2`).
  for (const kind of parsed.optionErrorKinds) {
    if (kind === 'ambiguous') {
      const ambiguous = parsed.ambiguousOptions[0]
      if (ambiguous !== undefined) return ambiguousOptionError(cmdName, ...ambiguous)
    } else if (kind === 'unexpected_value') {
      return unexpectedValueError(cmdName, parsed.invalidOptions[0] ?? '')
    } else if (kind === 'invalid') {
      return unknownOptionError(cmdName, parsed.invalidOptions[0] ?? '')
    } else if (kind === 'needs_value') {
      return missingValueError(cmdName, parsed.needsValueOptions[0] ?? '')
    } else if (kind === 'int') {
      const badInt = parsed.invalidIntOptions[0]
      if (badInt !== undefined) return invalidIntError(cmdName, ...badInt)
    } else if (kind === 'float') {
      const badFloat = parsed.invalidFloatOptions[0]
      if (badFloat !== undefined) return invalidFloatError(cmdName, ...badFloat)
    } else if (kind === 'value') {
      const badValue = parsed.invalidValueOptions[0]
      if (badValue !== undefined) return invalidArgumentError(cmdName, ...badValue)
    } else if (kind === 'ambiguous_value') {
      // gnulib's other wording for the same refusal, reached only by an
      // ARGMATCH table: the value is a prefix of two candidates or more.
      const badValue = parsed.ambiguousValueOptions[0]
      if (badValue !== undefined) {
        const [option, value, choices] = badValue
        return invalidArgumentError(cmdName, option, value, choices, undefined, 'ambiguous')
      }
    }
  }
  if (parsed.missingRequiredOptions.length > 0) {
    return missingRequiredError(cmdName, parsed.missingRequiredOptions[0] ?? '')
  }
  return null
}

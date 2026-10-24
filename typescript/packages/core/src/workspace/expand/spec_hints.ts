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

import { execSpans } from '../../commands/builtin/find_parse.ts'
import { walk } from '../../commands/cli/walk.ts'
import { BUILTIN_SPECS } from '../../commands/spec/builtins.ts'
import * as constants from '../../commands/spec/constants.ts'
import { parseCommand } from '../../commands/spec/parser.ts'
import type { ValueType } from '../../commands/spec/types.ts'
import { type CommandSpec } from '../../commands/spec/types.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionAccess } from '../../view/types.ts'

// Installed CLIs own their grammar. A mount command uses the selected
// invocation's spec, whether flat or a tree, so the same registration
// classifies the words and runs the command. A fallback flat command
// without declared arguments leaves path inference to the cwd/shared
// grammar; injected help/version options do not declare operand roles.
export function specForCommand(
  name: string,
  registry: MountRegistry,
  cwd: string,
  argv?: readonly string[],
  access?: SessionAccess,
): CommandSpec | null {
  const install = registry.clis.get(name)
  if (install !== null) return install.cli.spec
  const mount =
    argv === undefined
      ? registry.commandMount(name, [], cwd, access)
      : registry.invocationMount(name, [], cwd, argv, access)
  if (mount !== null) {
    const selected = mount.specFor(name)
    if (
      selected !== null &&
      (mount.cliFor(name) !== null ||
        selected.arguments.some(
          (arg) => arg !== constants.HELP_OPTION && arg !== constants.VERSION_OPTION,
        ))
    ) {
      return selected
    }
  }
  const spec = registry.mountFor(cwd).specFor(name)
  if (spec !== null) return spec
  return BUILTIN_SPECS[name] ?? null
}

// Classify argv words into per-position operand kinds.
//
// Delegates to parseCommand so flag syntax (clusters, --flag=value,
// multiple flags, providedBy) classifies identically to dispatch. Kinds
// are positional, not value sets, so the same word can be TEXT in one slot
// and PATH in another (`grep '*.txt' *.txt`). A flag token is TEXT even
// when it carries a path (`sort -o/data/s1.txt`): the parser resolves the
// value, and the shape heuristic would read the whole word as a path
// under the cwd.
//
// parseCommand classifies ignoreTokens as TEXT itself, so there is
// nothing to override here. A by-value override used to re-null them,
// which was both redundant and position-blind: it matched an option's
// value as readily as a grammar token, so `find /d -name '!'` lost the
// TEXT the parser had correctly given the pattern.
// find's `-exec` is the one grammar a spec cannot state (an option whose
// argument is a program, up to a terminator), so its words are overridden
// to TEXT here: the rest slot would otherwise read `echo`, `{}` and `;` as
// start points. The command name is what says the words are find's. A
// command tree's words are walked first, as its line runs: the verbs and
// group options are TEXT, and the leaf's words are its grammar's, its
// undeclared dashed words operands, as a CLI leaf parses them, under the
// session environment the run walks with (`env`): a required group option it
// fills would otherwise stop the walk short of the leaf.
export function specWordKinds(
  spec: CommandSpec,
  argv: readonly string[],
  name = '',
  env?: Readonly<Record<string, string>>,
): (ValueType | null)[] {
  const literal = argv.map(unmarkGlobs)
  if (spec.subcommands.length > 0) {
    const result = walk(name, spec, literal, '/', env ?? null)
    if (result.leaf === null) return literal.map(() => 'str')
    const lead: (ValueType | null)[] = literal
      .slice(0, literal.length - result.argv.length)
      .map(() => 'str')
    return [...lead, ...parseCommand(result.leaf, [...result.argv], '/', name, env, true).wordKinds]
  }
  const kinds = [...parseCommand(spec, literal, '/', name, env).wordKinds]
  if (name === 'find') {
    for (const [start, end] of execSpans(literal)) {
      for (let i = start; i <= end; i++) kinds[i] = 'str'
    }
  }
  return kinds
}

// Per-position base directories for a spec that declares one. tar's -C
// is a chdir for the operands typed after it, so those words are not
// relative to the session cwd at all. The parser already walks the line
// positionally, so it is what says where each word stood; this asks it,
// and only for the one command family that can answer (null everywhere
// else, so 92 of 93 specs pay nothing). A command tree's leaf declares its
// own, so a tree is walked to the leaf first, as specWordKinds walks it.
export function specWordBases(
  spec: CommandSpec,
  argv: readonly string[],
  cwd: string,
  name = '',
  env?: Readonly<Record<string, string>>,
): (string | null)[] | null {
  const literal = argv.map(unmarkGlobs)
  if (spec.subcommands.length > 0) {
    const result = walk(name, spec, literal, cwd, env ?? null)
    if (result.leaf?.operandBase == null) return null
    const lead: (string | null)[] = literal
      .slice(0, literal.length - result.argv.length)
      .map(() => null)
    return [...lead, ...parseCommand(result.leaf, [...result.argv], cwd, name, env, true).wordBases]
  }
  if (spec.operandBase === null) return null
  return [...parseCommand(spec, literal, cwd, '', env).wordBases]
}

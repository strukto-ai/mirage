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

import { findExprTail } from '../../../commands/builtin/find_parse.ts'
import { FILE_KEYS } from '../../../commands/builtin/generic/program.ts'
import { walk } from '../../../commands/cli/walk.ts'
import { SPECS } from '../../../commands/spec/index.ts'
import { isBuiltinGrammar } from '../../../commands/spec/builtins.ts'
import {
  OWN_OPTION_LOOP,
  REFUSED,
  STDIN_DASH_COMMANDS,
  STDIN_DASH_LEADING,
} from '../../../commands/spec/constants.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { parseCommand, parseToKwargs } from '../../../commands/spec/parser.ts'
import { DeviceInput, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { type MountRegistry } from '../../mount/registry.ts'
import { classifyBarePath } from '../../expand/classify/index.ts'
import { splitAssignment } from '../../../core/awk/builtins.ts'

// Commands a bare invocation points at the working directory, mapped to
// the typed spelling their synthetic operand carries. GNU find/tree/du/
// ls behave exactly as if `.` had been typed (./-prefixed output); GNU
// grep -r and bare rg print bare relative names (empty raw). Two gates:
// grep only defaults under -r/-R (and ignores stdin, GNU's rule); rg
// yields to an attached stdin, even an empty one (its readable-stdin
// rule), unless `-f -` reads it for patterns or --files lists. All pinned
// on debian:stable-slim / ripgrep 14.
export const CWD_DEFAULT_RAW: Record<string, string> = {
  grep: '',
  rg: '',
  find: '.',
  tree: '.',
  du: '.',
  ls: '.',
}

// The path options whose file the handler itself reads or writes through
// the dispatcher, keyed by command, valued by kwarg name: curl's -o and -D,
// jq's --rawfile and --slurpfile. Like a program file, such a file is no
// operand of the mount the line runs on, so it routes nothing: the line runs
// where its positional operands (or the cwd) put it, and `-o` and `-D` on two
// mounts, or `--slurpfile` over a process substitution, is not cross-mount.
export const DOOR_FLAG_KEYS: Readonly<Record<string, readonly string[]>> = {
  curl: ['output', 'dump_header'],
  jq: ['rawfile', 'slurpfile'],
}

// The synthetic cwd operand for a CWD_DEFAULT_RAW command typed bare.
// Injected before routing, so mount resolution, fan-out across
// descendant mounts, and respellRaw treat it exactly like a typed
// operand; backends never see the difference.
export function defaultCwdOperand(
  parts: readonly (string | PathSpec)[],
  cmdName: string,
  registry: MountRegistry,
  cwd: string,
  stdin: ByteSource | null,
): PathSpec | null {
  const spec = SPECS[cmdName]
  if (spec === undefined) return null
  // A typed `-` goes back to the parser as itself, as it does from
  // parseFlags, so `rg -f -` reads as stdin rather than a file `/-`.
  let argv = parts
    .slice(1)
    .map((p) => (typeof p === 'string' ? p : p.rawPath === '-' ? '-' : p.virtual))
  if (cmdName === 'find') {
    // Only the words before the expression can be start points: an
    // `-exec` command word or a `-newer` reference is the parser's.
    argv = argv.slice(0, argv.length - findExprTail(argv).length)
  }
  const parsed = parseCommand(spec, argv, cwd, cmdName)
  if (parsed.paths().length > 0) return null
  // --type-list reads no path, so there is no cwd to walk.
  if (cmdName === 'rg' && new FlagView(parseToKwargs(parsed), spec).asBool('type_list')) {
    return null
  }
  if (cmdName === 'grep') {
    const kwargs = parseToKwargs(parsed)
    if (kwargs.r !== true && kwargs.R !== true) return null
  } else if (cmdName === 'rg' && stdin !== null && !(stdin instanceof DeviceInput)) {
    const fl = new FlagView(parseToKwargs(parsed), spec)
    // `-f -` reads the attached stdin for patterns first, and --files lists
    // rather than searches, and either leaves ripgrep nothing to do with
    // stdin but walk the cwd instead. A stdin that is no file, FIFO or socket
    // (`< /dev/null`) is not searched either (grep_cli::is_readable_stdin,
    // ripgrep 14.1.1).
    if (!fl.asList('file').includes('-') && !fl.asBool('files')) return null
  }
  const operand = classifyBarePath('.', registry, cwd)
  if (typeof operand === 'string') return null
  return new PathSpec({
    virtual: operand.virtual,
    directory: operand.directory,
    vfsPath: operand.vfsPath,
    pattern: operand.pattern,
    resolved: operand.resolved,
    rawPath: CWD_DEFAULT_RAW[cmdName] ?? '',
  })
}

export function pathFlagScopes(cmdName: string, argv: string[], cwd: string): PathSpec[] {
  const spec = SPECS[cmdName]
  if (spec === undefined) return []
  const parsed = parseCommand(spec, argv, cwd, cmdName)
  const kwargs = parseToKwargs(parsed)
  const flagPaths = [...parsed.pathFlagValues]
  // A program file and a door option's file are read or written through the
  // dispatcher, not on the line's mount. A pair's name slots are words, never
  // resolved paths, so they match nothing here.
  for (const key of [FILE_KEYS[cmdName], ...(DOOR_FLAG_KEYS[cmdName] ?? [])]) {
    if (key === undefined) continue
    const value = kwargs[key]
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue
      const index = flagPaths.indexOf(item)
      if (index >= 0) flagPaths.splice(index, 1)
    }
  }
  return flagPaths.map(
    (value) =>
      new PathSpec({
        virtual: value,
        directory: value,
        vfsPath: '',
        rawPath: value,
      }),
  )
}

/**
 * The path operands a line names positionally, flag values left out.
 *
 * Classification turns every path-shaped word into a PathSpec, including the
 * value of a path-valued flag, so the classified word list cannot tell
 * `tar -xf a.tar -C /mnt` (extract INTO a mount) from `tar -cf a.tar /mnt`
 * (archive a whole mount). Only the spec knows which slot a word filled, so
 * this asks it and keeps the classified spec for each surviving operand,
 * whose `rawPath` is what a message should name.
 */
export function positionalScopes(
  cmdName: string,
  argv: string[],
  cwd: string,
  words: readonly (string | PathSpec)[],
): PathSpec[] {
  const spec = SPECS[cmdName]
  if (spec === undefined) {
    return words.filter((p): p is PathSpec => p instanceof PathSpec)
  }
  const parsed = parseCommand(spec, argv, cwd, cmdName)
  const byVirtual = new Map<string, PathSpec>()
  for (const word of words) {
    if (word instanceof PathSpec) byVirtual.set(word.virtual, word)
  }
  return parsed.args
    .filter(([, kind]) => kind === 'path')
    .map(
      ([value]) =>
        byVirtual.get(value) ??
        new PathSpec({ virtual: value, directory: value, vfsPath: '', rawPath: value }),
    )
}

/** The handler will answer help, version or a refusal before reading any input files. */
export function optionLoopExits(
  cmdName: string,
  spec: CommandSpec | null,
  argv: string[],
  cwd: string,
): boolean {
  if (spec === null || !OWN_OPTION_LOOP.has(cmdName) || !isBuiltinGrammar(cmdName, spec))
    return false
  const parsed = parseCommand(spec, argv, cwd, cmdName)
  const fl = new FlagView(parseToKwargs(parsed), spec)
  return fl.occurrences('help', 'version', REFUSED).length > 0
}

/**
 * The classified path words that route a line. Classification makes a door
 * option's file a path word like any other, so a command in DOOR_FLAG_KEYS
 * routes by its positional operands alone; every other command by all its
 * path words.
 */
export function routedOperands(
  cmdName: string,
  argv: string[],
  cwd: string,
  words: readonly (string | PathSpec)[],
  pathScopes: PathSpec[],
): PathSpec[] {
  if (!(cmdName in DOOR_FLAG_KEYS)) return pathScopes
  return positionalScopes(cmdName, argv, cwd, words)
}

/**
 * Drop the operands that name no path from a line's routing words. An awk
 * `var=value` operand is an assignment awk makes when its input reaches
 * it, so it routes nowhere: `awk p /data/a x=1 /data/b` runs on /data like
 * the same line without it. A lone `-` is standard input to the commands in
 * STDIN_DASH_COMMANDS, so it routes nowhere either, past STDIN_DASH_LEADING's
 * leading operands only where it names an output (split's PREFIX).
 */
export function routableScopes(cmdName: string, scopes: PathSpec[]): PathSpec[] {
  const leading = STDIN_DASH_LEADING.get(cmdName) ?? scopes.length
  const routed = STDIN_DASH_COMMANDS.has(cmdName)
    ? scopes.filter((s, index) => s.rawPath !== '-' || index >= leading)
    : scopes
  if (cmdName !== 'awk') return routed
  return routed.filter((s) => splitAssignment(s.rawPath) === null)
}

/** Combine positional and path-flag scopes, keeping operand order. */
export function mergeScopes(positional: PathSpec[], flagScopes: PathSpec[]): PathSpec[] {
  const merged = [...positional]
  const seen = new Set(merged.map((p) => p.virtual))
  for (const scope of flagScopes) {
    if (!seen.has(scope.virtual)) {
      seen.add(scope.virtual)
      merged.push(scope)
    }
  }
  return merged
}

/**
 * The line as an admission pattern reads it, and the program it runs.
 *
 * For an installed CLI head the spec walk names the verb path (global
 * options before the verb dropped, an alias canonicalized) and hands
 * back the leaf's own words, so `git -C /r push origin` reads as
 * `git push origin` and a rule on `git push` catches it; a walk the tree
 * refuses (unknown verb, bare group, usage error) reads the raw words,
 * since the line fails on its own. Anything else is the name and the raw
 * argv, and the program is the bare name.
 */
export function programTokens(
  registry: MountRegistry,
  name: string,
  argv: readonly string[],
  cwd: string,
): [readonly string[], readonly string[]] {
  const install = registry.clis.get(name)
  if (install !== null) {
    const result = walk(name, install.spec, argv, cwd)
    if (result.leaf !== null) {
      const program = [name, ...result.path]
      return [[...program, ...result.argv], program]
    }
  }
  return [[name, ...argv], [name]]
}

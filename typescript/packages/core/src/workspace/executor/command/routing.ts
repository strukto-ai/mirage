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
import { walk } from '../../../commands/cli/walk.ts'
import { SPECS } from '../../../commands/spec/index.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { parseCommand, parseToKwargs } from '../../../commands/spec/parser.ts'
import { DeviceInput, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { type MountRegistry } from '../../mount/registry.ts'
import { classifyBarePath } from '../../expand/classify/index.ts'

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
  const key = (
    { grep: '--file', rg: '--file', sed: '-f', awk: '-f', jq: '--from-file' } as Record<
      string,
      string
    >
  )[cmdName]
  const program = key === undefined ? undefined : parsed.flags[key]
  const programPaths = Array.isArray(program) ? program : [program]
  const flagPaths = [...parsed.pathFlagValues]
  for (const value of programPaths) {
    if (typeof value !== 'string') continue
    const index = flagPaths.indexOf(value)
    if (index >= 0) flagPaths.splice(index, 1)
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

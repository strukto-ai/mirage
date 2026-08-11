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

import { SPECS } from '../../../commands/spec/index.ts'
import { parseCommand, parseToKwargs } from '../../../commands/spec/parser.ts'
import type { ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { type MountRegistry } from '../../mount/registry.ts'
import { classifyBarePath } from '../../expand/classify/index.ts'

// Commands a bare invocation points at the working directory, mapped to
// the typed spelling their synthetic operand carries. GNU find/tree/du/
// ls behave exactly as if `.` had been typed (./-prefixed output); GNU
// grep -r and bare rg print bare relative names (empty raw). Two gates:
// grep only defaults under -r/-R (and ignores stdin, GNU's rule); rg
// yields to an attached stdin, even an empty one (its readable-stdin
// rule). All pinned on debian:stable-slim / ripgrep 14.
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
  const argv = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.virtual))
  const parsed = parseCommand(spec, argv, cwd)
  if (parsed.paths().length > 0) return null
  if (cmdName === 'grep') {
    const kwargs = parseToKwargs(parsed)
    if (kwargs.r !== true && kwargs.R !== true) return null
  } else if (cmdName === 'rg' && stdin !== null) {
    return null
  }
  const operand = classifyBarePath('.', registry, cwd)
  if (typeof operand === 'string') return null
  return new PathSpec({
    virtual: operand.virtual,
    directory: operand.directory,
    resourcePath: operand.resourcePath,
    pattern: operand.pattern,
    resolved: operand.resolved,
    rawPath: CWD_DEFAULT_RAW[cmdName] ?? '',
  })
}

export function pathFlagScopes(cmdName: string, argv: string[], cwd: string): PathSpec[] {
  const spec = SPECS[cmdName]
  if (spec === undefined) return []
  return parseCommand(spec, argv, cwd).pathFlagValues.map(
    (value) =>
      new PathSpec({
        virtual: value,
        directory: value,
        resourcePath: '',
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
  const parsed = parseCommand(spec, argv, cwd)
  const byVirtual = new Map<string, PathSpec>()
  for (const word of words) {
    if (word instanceof PathSpec) byVirtual.set(word.virtual, word)
  }
  return parsed.args
    .filter(([, kind]) => kind === 'path')
    .map(
      ([value]) =>
        byVirtual.get(value) ??
        new PathSpec({ virtual: value, directory: value, resourcePath: '', rawPath: value }),
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

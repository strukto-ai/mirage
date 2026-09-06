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

import type { SessionView } from '../../ops/types.ts'
import { scopesPaths } from '../../policy/match/reads.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { PathSpec, wordText } from '../../types.ts'
import { literalWord, markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { WordPolicy, endOptionsAfterProgram, lookup, wordPolicy } from '../lookup/index.ts'
import type { Session } from '../session/session.ts'
import { classifyParts } from './classify/index.ts'
import type { NamespaceLinks } from '../../ops/config.ts'
import { globNeedsShell, globOptions, resolveGlobs } from './globs.ts'
import { type ExecuteFn } from './node.ts'
import { expandWords } from './parts.ts'
import { type ValueType } from '../../commands/spec/types.ts'
import { specForCommand, specWordBases, specWordKinds } from './spec_hints.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/**
 * One command's expanded argument vector.
 *
 * `expandArgv` is the only place allowed to know that word zero of an
 * expanded command is its name; every consumer reads named views
 * instead of slicing word lists.
 *
 * `args` and `operands` are two views of the same final word list and
 * always have equal length; they differ only in element type. Glob
 * words are resolved by whoever consumes them, exactly once: shell
 * consumers get shell-resolved words in both views, mount commands
 * keep pattern PathSpecs for backend pushdown.
 */
export class Argv {
  /** Expanded command name. */
  readonly name: string
  /** Text view (what builtins consume). */
  readonly args: readonly string[]
  /** Classified view (what mount dispatch, test, and ln consume). */
  readonly operands: readonly (string | PathSpec)[]

  constructor(name: string, args: readonly string[], operands: readonly (string | PathSpec)[]) {
    this.name = name
    this.args = args
    this.operands = operands
    Object.freeze(this)
  }

  /** Full classified word list, name included. */
  get words(): (string | PathSpec)[] {
    if (this.name === '' && this.operands.length === 0) return []
    return [this.name, ...this.operands]
  }

  /** Copy with the classified view replaced (e.g. after symlink rewriting). */
  withOperands(operands: readonly (string | PathSpec)[]): Argv {
    return new Argv(this.name, this.args, [...operands])
  }
}

/**
 * Expand, classify, and glob-resolve a command's word nodes.
 *
 * Uses the cwd mount's CommandSpec (when it has one for the command) to
 * decide which words are TEXT (skip classification) and which are PATH
 * (classify even bare filenames).
 */
export async function expandArgv(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  registry: MountRegistry,
  namespace: NamespaceLinks | null = null,
  view?: SessionView,
): Promise<Argv> {
  let expanded = await expandWords(parts, session, executeFn, callStack, view)
  if (expanded.length === 0) return new Argv('', [], [])
  // `set -f` turns pathname expansion off, which is the same word for
  // word as every glob character having been quoted.
  if (session.shellOptions.noglob === true) expanded = expanded.map((w) => markGlobs(w))
  // A command name may span several leading words (git-style, e.g.
  // `gws docs documents get`); the registry says how many.
  const consumed = registry.matchCommandPrefix(expanded)
  const name = unmarkGlobs(expanded.slice(0, consumed).join(' '))
  // Before anything reads the line: an option carrying a program hands
  // the words after it to that program, and POSIX's own `--` is how that
  // handoff is spelled. Only when the interpreter is what runs, though:
  // a shell function of the same name takes the line instead (bash's own
  // rule), and it must receive the words as typed rather than a marker
  // meant for a parser it does not have. `command python3` masks the
  // function for its inner run, which is exactly when the rewrite
  // applies again. A CLI cannot reach here at all, since registerCli
  // refuses a shell builtin's name.
  const shadowed = Object.hasOwn(session.functions, name)
  const line = expanded.slice(consumed)
  const tail = shadowed ? line : endOptionsAfterProgram(name, line)
  const lineWords = [...expanded.slice(0, consumed), ...tail]

  const policy = wordPolicy(lookup(name, session, registry))
  let wordKinds: (ValueType | null)[] | null = null
  let wordBases: (string | null)[] | null = null
  if (policy === WordPolicy.MOUNT) {
    const spec = specForCommand(name, registry, session.cwd)
    if (spec !== null) {
      const extra: (ValueType | null)[] = new Array<ValueType | null>(consumed - 1).fill('str')
      wordKinds = [...extra, ...specWordKinds(spec, lineWords.slice(consumed), name)]
      const bases = specWordBases(spec, lineWords.slice(consumed), session.cwd)
      if (bases !== null) {
        wordBases = [...new Array<string | null>(consumed - 1).fill(null), ...bases]
      }
    }
  }

  const classified = classifyParts(lineWords, registry, session.cwd, wordKinds, wordBases)
  // A glob word is resolved by whoever consumes it, exactly once:
  // WordPolicy.SHELL words get matches here; mount commands keep
  // patterns for backend pushdown; unknown names fail without
  // touching backends.
  // So does a command a path-scoped rule names: the admission gate reads
  // the words before the backend would resolve them, and a pattern that
  // only later matches under the rule's path would pass a gate its
  // matches fail.
  const globOpts = globOptions(session)
  const words =
    policy === WordPolicy.SHELL || globNeedsShell(globOpts) || scopesPaths(session.commands, name)
      ? await resolveGlobs(classified, registry, false, namespace, globOpts)
      : // A pattern still owes its backend a resolution, so it travels
        // marked and the marks come off there; every other word is done
        // with its quoting and reads literally from here on.
        classified.map((item) =>
          item instanceof PathSpec && item.pattern !== null ? item : literalWord(item),
        )
  // The text view renders words as typed (rawPath): bash hands
  // programs their words unchanged, so `echo sub/file.txt` prints the
  // relative form, not the resolved absolute path. Quote removal is part
  // of "as typed": a word never reaches a command marked.
  const textView = words.map((w) => unmarkGlobs(wordText(w)))
  return new Argv(name, textView.slice(consumed), words.slice(consumed))
}

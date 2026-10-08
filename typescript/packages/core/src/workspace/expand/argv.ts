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

import type { EvaluationContext } from '../evaluation.ts'
import type { RouteDecision } from '../../runtime/routing/types.ts'
import type { NamespaceLinks, SessionView } from '../../doors/types.ts'
import { scopesPaths } from '../../policy/match/reads.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { PathSpec, wordText } from '../../types.ts'
import { hasGlob, literalWord, markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { INTERPRETER_NAMES } from '../lookup/constants.ts'
import {
  Consumer,
  WordPolicy,
  endOptionsAfterProgram,
  lookup,
  runtimeRefused,
  wordPolicy,
} from '../lookup/index.ts'

import { classifyParts } from './classify/index.ts'
import { globNeedsShell, globOptions, resolveGlobs } from './globs.ts'
import { type ExecuteFn } from './node.ts'
import { expandWords } from './parts.ts'
import { type CommandSpec, type ValueType } from '../../commands/spec/types.ts'
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
  /** Original words forming the matched name. */
  readonly prefix: readonly string[]

  constructor(
    name: string,
    args: readonly string[],
    operands: readonly (string | PathSpec)[],
    prefix: readonly string[] = [name],
  ) {
    this.name = name
    this.args = args
    this.operands = operands
    this.prefix = prefix
    Object.freeze(this)
  }

  /** Native argv, preserving word boundaries within a matched name. */
  get tokens(): [string, ...string[]] {
    const [head = this.name, ...tail] = this.prefix
    return [head, ...tail, ...this.args]
  }

  /** Full classified word list, name included. */
  get words(): (string | PathSpec)[] {
    if (this.name === '' && this.operands.length === 0) return []
    return [this.name, ...this.operands]
  }

  /** Copy with the classified view replaced (e.g. after symlink rewriting). */
  withOperands(operands: readonly (string | PathSpec)[]): Argv {
    return new Argv(this.name, this.args, [...operands], this.prefix)
  }
}

/**
 * Expand, classify, and glob-resolve a command's word nodes.
 *
 * Uses the cwd mount's CommandSpec (when it has one for the command) to
 * decide which words are TEXT (skip classification) and which are PATH
 * (classify even bare filenames). A program's line (a native capture,
 * or an interpreter run in-process) is globbed whatever the slots, as
 * bash globs it, and its words are then classified for the slots the
 * expanded words fill.
 */
export async function expandArgv(
  parts: TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  registry: MountRegistry,
  namespace: NamespaceLinks | null = null,
  view?: SessionView,
  routing?: RouteDecision,
): Promise<Argv> {
  const session = context.session
  let expanded = await expandWords(parts, context, executeFn, callStack, view)
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
  const consumer = lookup(name, session, registry, routing)
  const refused = runtimeRefused(name, session, registry, routing)
  const shadowed = Object.hasOwn(session.functions, name) || consumer === Consumer.EXTERNAL
  const line = expanded.slice(consumed)
  const tail = shadowed ? line : endOptionsAfterProgram(name, line)
  const lineWords = [...expanded.slice(0, consumed), ...tail]

  const policy = wordPolicy(consumer)
  // A native program gets its words the way bash hands them over, with
  // every unquoted glob already expanded, whatever slot the word fills.
  const native = consumer === Consumer.EXTERNAL && !refused
  // So does an interpreter run in-process. The words after its program
  // are that program's argv, handed over as typed, and only its script is
  // a file it opens: the spec's script slot makes that one word a path, so
  // a rule protecting `secret.py` reads `python3 secret.py` however the
  // script is spelled, while `python3 s.py data/in.csv` hands the script
  // `data/in.csv` and a `/tmp/q.txt` beside a script on /workspace names
  // no second mount.
  const inProcess = consumer === Consumer.SESSION && INTERPRETER_NAMES.has(name)
  const program = native || inProcess
  let spec: CommandSpec | null = null
  let wordKinds: (ValueType | null)[] | null = null
  let wordBases: (string | null)[] | null = null
  // Native captures and interpreters still need the spec's path roles
  // for admission.
  if (policy === WordPolicy.MOUNT || consumer === Consumer.EXTERNAL || inProcess) {
    spec = specForCommand(name, registry, session.cwd)
    if (spec !== null) {
      const extra: (ValueType | null)[] = new Array<ValueType | null>(consumed - 1).fill('str')
      wordKinds = [...extra, ...specWordKinds(spec, lineWords.slice(consumed), name)]
      const bases = specWordBases(spec, lineWords.slice(consumed), session.cwd)
      if (bases !== null) {
        wordBases = [...new Array<string | null>(consumed - 1).fill(null), ...bases]
      }
    }
  }
  if (program) {
    // bash globs every unquoted word before the program reads any of
    // them, whatever slot it fills and whatever it looks like:
    // `python3 s.py *.txt` gets the matches, `.*.txt` the dotfiles and
    // `x=*` a file named `x=1`, and a glob that matches nothing stays the
    // word as typed. So a word carrying a live glob character is a
    // pattern here, spec or no spec, rather than a shell word the shape
    // rules read. A quoted one carries marks rather than glob characters,
    // so it stays text.
    const tail = lineWords.slice(consumed)
    const own = wordKinds !== null ? wordKinds.slice(consumed - 1) : tail.map(() => null)
    wordKinds = [
      ...new Array<ValueType | null>(consumed - 1).fill('str'),
      ...tail.map((word, i): ValueType | null => (hasGlob(word) ? 'path' : (own[i] ?? null))),
    ]
  }

  const classified = classifyParts(lineWords, registry, session.cwd, wordKinds, wordBases)
  // A glob word is resolved by whoever consumes it, exactly once:
  // WordPolicy.SHELL words get matches here; mount commands keep
  // patterns for backend pushdown; unknown names fail without
  // touching backends.
  // So does a command a path-scoped rule names: the admission gate reads
  // the words before the backend would resolve them, and a pattern that
  // only later matches under the rule's path would pass a gate its
  // matches fail. And so does a pattern that walks a `.` or `..`, which no
  // backend key holds.
  const globOpts = globOptions(session)
  let words =
    !refused &&
    (policy === WordPolicy.SHELL ||
      globNeedsShell(globOpts) ||
      scopesPaths(session.commands, name) ||
      classified.some((w) => w instanceof PathSpec && w.pattern !== null && w.dotted !== null))
      ? await resolveGlobs(classified, registry, false, namespace, globOpts)
      : // A pattern still owes its backend a resolution, so it travels
        // marked and the marks come off there; every other word is done
        // with its quoting and reads literally from here on.
        classified.map((item) =>
          item instanceof PathSpec && item.pattern !== null ? item : literalWord(item),
        )
  if (program && spec !== null) {
    words = programWords(words, spec, name, consumed, registry, session.cwd)
  }
  // The text view renders words as typed (rawPath): bash hands
  // programs their words unchanged, so `echo sub/file.txt` prints the
  // relative form, not the resolved absolute path. Quote removal is part
  // of "as typed": a word never reaches a command marked.
  const textView = words.map((w) => unmarkGlobs(wordText(w)))
  return new Argv(
    name,
    textView.slice(consumed),
    words.slice(consumed),
    expanded.slice(0, consumed).map(unmarkGlobs),
  )
}

/**
 * Classify a program's words for the argv it receives.
 *
 * bash expands every glob before the program parses its argv, so a
 * match can fill a slot of another kind than the word it came from:
 * `grep *.txt` hands grep its pattern and its files out of one word, and
 * a glob's extra matches push every later word into a later slot. The
 * spec therefore reads the expanded words, which are literal from here
 * on, and each word is classified for the slot it now fills. Admission
 * then judges the paths the program opens, and a match in a text slot is
 * text, exactly like the same word typed by hand. A glob that matched
 * nothing keeps the pattern spec the resolver left in a path slot, and is
 * its typed text in a text slot.
 */
function programWords(
  words: readonly (string | PathSpec)[],
  spec: CommandSpec,
  name: string,
  consumed: number,
  registry: MountRegistry,
  cwd: string,
): (string | PathSpec)[] {
  const literal = words.map((w) => markGlobs(wordText(w)))
  const kinds: (ValueType | null)[] = [
    ...new Array<ValueType | null>(consumed - 1).fill('str'),
    ...specWordKinds(spec, literal.slice(consumed), name),
  ]
  const bases = specWordBases(spec, literal.slice(consumed), cwd)
  const reread = classifyParts(
    literal,
    registry,
    cwd,
    kinds,
    bases === null ? null : [...new Array<string | null>(consumed - 1).fill(null), ...bases],
  )
  const out: (string | PathSpec)[] = [words[0] ?? '']
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? ''
    const kind = kinds[i - 1] ?? null
    if (!(word instanceof PathSpec && word.pattern !== null)) {
      out.push(literalWord(reread[i] ?? ''))
    } else if (kind === null || kind === 'path') {
      out.push(word)
    } else {
      out.push(literalWord(wordText(word)))
    }
  }
  return out
}

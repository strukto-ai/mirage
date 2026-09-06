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

import { type ByteSource, IOResult } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { getDeclarationKeyword, getText } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { SessionView } from '../../ops/types.ts'
import {
  handleDeclareFunctions,
  handleDeclarePrint,
  handleExport,
  handleLocal,
  handleReadonly,
  noteLocalArray,
} from '../executor/builtins/index.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import {
  conversionScalar,
  ensureVarVisible,
  seedVar,
  sessionView,
  setAttr,
} from '../session/state.ts'
import { ExecutionNode } from '../types.ts'
import { expandArrayItems } from './assignment.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Fold kind-conversion refusals into a declaration's result.
 *
 * GNU reports `cannot convert indexed to associative array` per refused
 * name on stderr and fails the builtin with 1 while the other operands
 * still declare, so the refusals ride the handler's own result rather
 * than replacing it.
 */
function mergeConversionErrors(result: Result, errors: readonly string[]): Result {
  if (errors.length === 0) return result
  const [stream, io, node] = result
  const extra = new TextEncoder().encode(errors.join('\n') + '\n')
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(0)
  const merged = new Uint8Array(prior.length + extra.length)
  merged.set(prior, 0)
  merged.set(extra, prior.length)
  const newIo = new IOResult({
    exitCode: 1,
    stderr: merged,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
  })
  return [stream, newIo, new ExecutionNode({ command: node.command, exitCode: 1, stderr: merged })]
}

// Every letter GNU's `declare` accepts, so a typo refuses with the usage
// line instead of being silently dropped. `-a`/`-A` are kinds, not
// attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
// /`-I` are modes the handlers read. `-n` is accepted and stored, but
// aliasing (reads and writes through the reference) is not wired: it is
// a separate seam through every expansion site, so a name carrying it
// declares and prints, and nothing more, rather than a partial alias
// that works in some spellings and not others.
// `-n` stores the reference and every reader and writer resolves through
// it (`deref` in `session/state`).
const DECLARE_LETTERS: ReadonlySet<string> = new Set('aAfFgiIlnprtux')
const DECLARE_USAGE =
  'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]'
// The stored attributes a `-letter` / `+letter` toggles.
const ATTR_LETTERS: ReadonlyMap<string, VarAttr> = new Map([
  ['i', VarAttr.Integer],
  ['l', VarAttr.Lower],
  ['u', VarAttr.Upper],
  ['n', VarAttr.Nameref],
  ['t', VarAttr.Trace],
  ['x', VarAttr.Export],
  ['r', VarAttr.Readonly],
])

/** The attributes the given letters name, in the order given, skipping
 * letters that name none (kinds and modes are not attributes). */
function attrsFor(letters: string, has: (c: string) => boolean): VarAttr[] {
  const out: VarAttr[] = []
  for (const c of letters) {
    const attr = ATTR_LETTERS.get(c)
    if (attr !== undefined && has(c)) out.push(attr)
  }
  return out
}

/**
 * The refusal a `declare` family option cluster earns, if any.
 *
 * An unknown letter is GNU's `invalid option` plus the usage line, exit
 * 2, and it wins over every other check because bash refuses the
 * cluster before it looks at a single operand.
 */
function declareOptionRefusal(
  cmd: string,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
): Result | null {
  const bad = [...flagChars, ...plusChars]
    .sort(compareCodePoints)
    .find((c) => !DECLARE_LETTERS.has(c))
  if (bad === undefined) return null
  const sign = flagChars.has(bad) ? '-' : '+'
  const err = new TextEncoder().encode(
    `bash: ${cmd}: ${sign}${bad}: invalid option\n${DECLARE_USAGE}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 2, stderr: err }),
  ]
}

/**
 * The per-name refusals a `+letter` earns after the operands are known.
 *
 * Two letters cannot be taken off. `+r` on a readonly name is
 * `declare: R: readonly variable`, exit 1, and the name stays frozen.
 * `+a` / `+A` on an array is `cannot destroy array variables in this
 * way`, exit 1, since the kind is what the value is, not a mark. Both
 * are pinned on 5.2.37 and neither stops the other operands from
 * declaring; the first refusal is what the builtin reports.
 */
function plusRefusals(
  cmd: string,
  session: Session,
  view: SessionView,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
): Result | null {
  if (!plusChars.has('r') && !plusChars.has('a') && !plusChars.has('A')) return null
  const names = assignments.map((a) => a.split('=')[0] ?? a)
  for (const { name } of staged ?? []) names.push(name)
  for (const name of names) {
    if (plusChars.has('r') && view.isReadonly(name)) {
      const err = new TextEncoder().encode(`bash: ${cmd}: ${name}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
    if (
      (plusChars.has('a') && Object.hasOwn(session.arrays, name)) ||
      (plusChars.has('A') && Object.hasOwn(session.assocs, name))
    ) {
      const err = new TextEncoder().encode(
        `bash: ${cmd}: ${name}: cannot destroy array variables in this way\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
  }
  return null
}

/**
 * Apply every `-attr` / `+attr` letter to the names a declaration
 * stored, on top of the export stamp.
 *
 * The letters that shape a value (`-i -l -u`) are stored as attributes
 * and applied by the door on every *later* write, which is GNU's rule:
 * `v=MiXeD; declare -l v` keeps `MiXeD`, and the next `v=ABC` stores
 * `abc`. So this stamps and never rewrites. `-l` and `-u` are exclusive:
 * setting one clears the other, and a cluster naming both (`-lu`, `-ul`)
 * sets neither, both pinned on 5.2.37. A `+` letter clears; `+r` is
 * refused earlier on a readonly name and a no-op otherwise, so it is not
 * an off toggle. Through the gated mark door for every name, covered or
 * not: the handler already cleared the gate for these names, so this is
 * one redundant policy call per attribute, and it keeps this stamp out
 * of the ungated-write allowlist that `setAttr` sites must justify.
 */
async function stampAttrs(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  const refused = await stampExport(session, view, flagChars, assignments, staged, stored)
  if (refused !== null) return refused
  let onAttrs = attrsFor('ilunt', (c) => flagChars.has(c) && !plusChars.has(c))
  if (flagChars.has('l') && flagChars.has('u')) {
    onAttrs = onAttrs.filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper)
  }
  const offAttrs = attrsFor('iluntx', (c) => plusChars.has(c))
  if (onAttrs.length === 0 && offAttrs.length === 0) return null
  try {
    for (const name of stored) {
      for (const attr of onAttrs) {
        await view.mark(name, attr, true)
        // `-l` displaces `-u` and vice versa; the record keeps one.
        if (attr === VarAttr.Lower) await view.mark(name, VarAttr.Upper, false)
        else if (attr === VarAttr.Upper) await view.mark(name, VarAttr.Lower, false)
      }
      for (const attr of offAttrs) await view.mark(name, attr, false)
    }
  } catch (err) {
    if (!(err instanceof PolicyDenied)) throw err
    const denied = new TextEncoder().encode(`${err.message}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: denied }),
      new ExecutionNode({ command: 'declare', exitCode: 1, stderr: denied }),
    ]
  }
  return null
}

/**
 * Mark every name a `-x` declaration stored as exported.
 *
 * `declare -x NAME` marks an existing name without touching its value and
 * `declare -x NAME=v` assigns then marks, so the stamp lands after the
 * assignment either way. Staged array literals are stamped too, since an
 * array is as exportable as a scalar: GNU answers `declare -x A=(a b)`
 * with `declare -ax A=([0]="a" [1]="b")`, and reading only `assignments`
 * left every `declare -x NAME=(...)` unmarked.
 *
 * Shared by the readonly and the plain declaration branch because
 * `declare -rx X=1` goes down the readonly one and still owes the export
 * attribute.
 *
 * Only the names the handler reports storing are marked, and marking is
 * not gated on the aggregate status: a declaration keeps its valid
 * operands when a sibling refuses, so `declare -x GOOD=1 1BAD=x` exits 1
 * and still answers `declare -x GOOD="1"`.
 *
 * A name that carried a value went through `view.set`, so its mark rides
 * on that decision; a bare name did not, and on an *existing* name the
 * handler writes nothing at all, so the mark is the only session write
 * there is and has to clear `pre_session` itself. Stamping it through
 * `setAttr` let `declare -x AWS_TOKEN` export a host-seeded credential
 * the deployment had refused.
 */
async function stampExport(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  if (!flagChars.has('x')) return null
  const covered = new Set<string>()
  for (const a of assignments) {
    const eq = a.indexOf('=')
    if (eq >= 0) covered.add(a.slice(0, eq))
  }
  for (const { name } of staged ?? []) covered.add(name)
  for (const name of stored) {
    if (covered.has(name)) {
      setAttr(session, name, VarAttr.Export)
      continue
    }
    try {
      await view.mark(name, VarAttr.Export, true)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const encoded = new TextEncoder().encode(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encoded }),
        new ExecutionNode({ command: 'declare', exitCode: 1, stderr: encoded }),
      ]
    }
  }
  return null
}

/**
 * Execute one declaration statement (export/local/declare/readonly).
 *
 * The executor only reads the operands: it expands them, sorts them
 * into option letters, plain names and staged array literals, then
 * hands the result to the builtin handler that owns the keyword. The
 * attribute letters (`-x`, `-i`, `-l`) are stamped afterwards through
 * the same gated door, so `declare -rx X=1` keeps both marks.
 */
export async function executeDeclaration(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<Result> {
  const keyword = getDeclarationKeyword(node)
  const assignments: string[] = []
  // Array literals are staged, not stored: `readonly -a a=(y)` on an
  // already-readonly name has to fail with the old value intact.
  const staged: { name: string; append: boolean; items: string[] }[] = []
  // Option words are kept verbatim, in order, so `--` survives as an
  // end-of-options marker and the handlers can name the *first* bad option
  // letter the way bash does.
  const flagWords: string[] = []
  const flagChars = new Set<string>()
  const plusChars = new Set<string>()
  let optsDone = false
  for (const child of node.namedChildren) {
    if (child.type === NT.VARIABLE_ASSIGNMENT) {
      const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      const firstVal = valNodes[0]
      if (firstVal?.type === NT.ARRAY) {
        const text = getText(child)
        const eq = text.indexOf('=')
        const key = eq >= 0 ? text.slice(0, eq) : text
        const append = key.endsWith('+')
        staged.push({
          name: append ? key.slice(0, -1) : key,
          append,
          items: await expandArrayItems(
            firstVal,
            session,
            executeFn,
            registry,
            namespace,
            callStack,
          ),
        })
        continue
      }
      assignments.push(
        await expandNode(
          child,
          session,
          executeFn,
          callStack,
          sessionView(session, registry.policies),
        ),
      )
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.CONCATENATION ||
      child.type === NT.WORD ||
      // A bare `readonly NAME` / `export NAME` operand parses as a
      // variable_name, not a word, and a quoted assignment
      // (`export 'FOO=bar'`) as a plain string operand.
      child.type === NT.VARIABLE_NAME ||
      child.type === NT.STRING ||
      child.type === NT.RAW_STRING ||
      child.type === NT.ANSI_C_STRING ||
      child.type === NT.TRANSLATED_STRING
    ) {
      const expanded = await expandNode(
        child,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      // An *unquoted* expansion that came back empty is removed by
      // word splitting, so `export $UNSET` is a bare `export` and
      // prints the listing. A quoted one is a real, empty operand:
      // GNU answers both `export ""` and `export "$UNSET"` with
      // ``export: `': not a valid identifier``, so it has to reach
      // the builtin rather than vanish here.
      if (expanded === '' && (child.type === NT.SIMPLE_EXPANSION || child.type === NT.EXPANSION))
        continue
      if (!optsDone && expanded.startsWith('-') && expanded.length > 1) {
        flagWords.push(expanded)
        if (expanded === '--') optsDone = true
        else for (const ch of expanded.slice(1)) flagChars.add(ch)
      } else if (
        !optsDone &&
        expanded.startsWith('+') &&
        expanded.length > 1 &&
        (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
      ) {
        // `+attr` turns an attribute off. Only the declare family
        // reads it: `export +x` and `readonly +r` are `not a valid
        // identifier` in GNU, so for those two the word falls through
        // as an operand and refuses there.
        for (const ch of expanded.slice(1)) plusChars.add(ch)
      } else {
        assignments.push(expanded)
      }
    }
  }
  const cmdWord = keyword === NT.LOCAL ? 'local' : keyword
  if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
    const refused = declareOptionRefusal(cmdWord, flagChars, plusChars)
    if (refused !== null) return refused
  }
  if (
    (flagChars.has('f') || flagChars.has('F')) &&
    (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
  ) {
    // `-f`/`-F` select functions, not variables: `-rf` freezes, `-f
    // NAME` prints the body, `-F NAME` prints the name, and a missing
    // name is exit 1 without a word.
    return handleDeclareFunctions(cmdWord, session, flagChars, assignments)
  }
  const isReadonly = keyword === 'readonly' || flagChars.has('r')
  // `-l` and `-u` cannot both hold; a cluster naming both sets neither
  // (pinned: `declare -lu s=aBc` prints `declare -- s`).
  let shaping = new Set(attrsFor('ilu', (c) => flagChars.has(c) && !plusChars.has(c)))
  if (shaping.has(VarAttr.Lower) && shaping.has(VarAttr.Upper)) {
    shaping = new Set([...shaping].filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper))
  }
  const conversionErrors: string[] = []
  if (flagChars.has('A') || flagChars.has('a')) {
    // `declare -a NAME` / `declare -A NAME` with no value declare an
    // empty array of that kind, so ${#NAME[@]} is 0 and an element
    // write leaves the other slots unassigned. GNU refuses to
    // convert between the two kinds and says so per name while the
    // rest of the operands still declare.
    const wantAssoc = flagChars.has('A')
    for (const bare of assignments) {
      if (bare.includes('=')) continue
      // Both branches below write array storage raw (the top-level
      // one migrates an existing scalar), so a hidden name refuses
      // like any assignment spelling before either lands.
      try {
        ensureVarVisible(session, bare)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        throw new ExitSignal(1, new TextEncoder().encode(`${err.message}\n`), null, 1)
      }
      if (wantAssoc && Object.hasOwn(session.arrays, bare)) {
        conversionErrors.push(
          `bash: ${cmdWord}: ${bare}: cannot convert indexed to associative array`,
        )
        continue
      }
      if (!wantAssoc && Object.hasOwn(session.assocs, bare)) {
        conversionErrors.push(
          `bash: ${cmdWord}: ${bare}: cannot convert associative to indexed array`,
        )
        continue
      }
      if (!flagChars.has('g') && noteLocalArray(session, bare)) {
        // Inside a function this shadows whatever the caller had with
        // a fresh empty array of the declared kind; `-g` declares at
        // global scope instead.
        seedVar(session, bare, wantAssoc ? {} : [])
      } else if (wantAssoc && !Object.hasOwn(session.assocs, bare)) {
        // At top level an existing scalar becomes the value at the
        // literal key "0" (GNU allows scalar-to-associative
        // conversion, unlike indexed).
        const scalar = conversionScalar(session, bare)
        seedVar(session, bare, scalar === undefined ? {} : { '0': scalar })
      } else if (!wantAssoc && !Object.hasOwn(session.arrays, bare)) {
        // At top level an existing scalar becomes element 0.
        const scalar = conversionScalar(session, bare)
        seedVar(session, bare, scalar === undefined ? [] : [scalar])
      }
    }
  }
  // Array literals travel as data: the handler stores them through
  // the session door and owns both refusal voices, so the executor
  // only expands and stages.
  if (isReadonly) {
    // Only the `readonly` keyword owns -p / illegal-option handling;
    // `declare -r` keeps names only.
    const declView = sessionView(session, registry.policies)
    const stored: string[] = []
    const result =
      keyword === 'readonly'
        ? await handleReadonly(
            [...flagWords, ...assignments],
            session,
            declView,
            staged,
            stored,
            flagChars.has('A'),
            shaping,
          )
        : await handleReadonly(
            assignments,
            session,
            declView,
            staged,
            stored,
            flagChars.has('A'),
            shaping,
          )
    // `declare -rx X=1` carries both attributes: GNU prints
    // `declare -rx X="1"`. Readonly answers first, so the export stamp
    // has to land here too, or `-r` silently ate the `-x`.
    const refused = await stampAttrs(
      session,
      declView,
      flagChars,
      plusChars,
      assignments,
      staged,
      stored,
    )
    return refused ?? mergeConversionErrors(result, conversionErrors)
  }
  // declare/typeset scope like `local` inside a function (bash
  // semantics) and assign globally at top level, which is exactly
  // handleLocal's fallback when no function scope is active.
  if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
    // `-p` prints rather than declares, so it is answered before the
    // assignment path runs at all.
    if (
      (flagChars.has('p') || plusChars.has('p')) &&
      (keyword === 'declare' || keyword === 'typeset')
    ) {
      return handleDeclarePrint(assignments, session)
    }
    const declView2 = sessionView(session, registry.policies)
    const stored2: string[] = []
    const result = await handleLocal(
      assignments,
      session,
      declView2,
      staged,
      // `declare`/`typeset` share this handler but have to name
      // themselves in a diagnostic rather than say `local`.
      cmdWord,
      stored2,
      flagChars.has('A'),
      shaping,
      flagChars.has('n') && !plusChars.has('n'),
      flagChars.has('g'),
    )
    const plusRefused = plusRefusals(cmdWord, session, declView2, plusChars, assignments, staged)
    if (plusRefused !== null) return plusRefused
    const refused2 = await stampAttrs(
      session,
      declView2,
      flagChars,
      plusChars,
      assignments,
      staged,
      stored2,
    )
    return refused2 ?? mergeConversionErrors(result, conversionErrors)
  }
  // Pass export flags through so -p / bare print and illegal options work.
  const exportResult = await handleExport(
    [...flagWords, ...assignments],
    session,
    sessionView(session, registry.policies),
    staged,
  )
  return mergeConversionErrors(exportResult, conversionErrors)
}

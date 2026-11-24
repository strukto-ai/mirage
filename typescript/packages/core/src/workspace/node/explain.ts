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

import { WordKind } from '../../commands/spec/types.ts'
import { currentCaller, voiceName } from '../../context/session_context.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { PermissionsPolicy, decisionOf, renderCommandDeny, renderDeny } from '../../policy/index.ts'
import { isPending } from '../../policy/decisions.ts'
import { sourceOf } from '../../policy/match/decide.ts'
import { hasRules, readsArgs, scopesPaths } from '../../policy/match/reads.ts'
import { commandRoute, settled } from '../../policy/policies.ts'
import {
  Outcome,
  type AdmissionRules,
  type Ask,
  type Claimant,
  type CommandContext,
  type CommandExplanation,
  type CommandRule,
  type Deny,
  type HandOff,
  type Occurrence,
  type Pending,
  type Route,
  type ShellExplanation,
  type ShellNode,
  type CommandWord,
} from '../../policy/types.ts'
import {
  inputSubstitutionRedirect,
  getCaseItems,
  getCaseWord,
  getIfBranches,
  getFunctionName,
  isBackgrounded,
  getParts,
  getText,
  literalWord,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import {
  backgroundPipeline,
  connectionRunsRight,
  NodeKind,
  nodeKind,
  pipelineStageForks,
  ScopeKind,
  scopeKind,
} from '../../shell/node_kind.ts'
import { parseOptionWord } from '../../shell/options.ts'
import { opaqueReads, referencedNames } from '../../shell/parse/index.ts'
import { walkTree } from '../../shell/parse/names.ts'
import { NodeType, type TSNodeLike } from '../../shell/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import { PathSpec, type PolicyDecision } from '../../types.ts'
import { isGlob } from '../../utils/hidden.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { resolvePath } from '../../utils/path.ts'
import { envChild, envVars } from '../executor/builtins/env/env.ts'
import { scanOptions } from '../executor/builtins/getopt.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import { lineFacts } from '../lookup/index.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { SessionState } from '../session/session.ts'
import { tildeHomes } from '../session/shell_dirs.ts'
import { envIsReadonly, envSnapshot, seedVar, setAttr } from '../session/state.ts'
import {
  admitRedirect,
  classifiedWords,
  gate,
  openedBy,
  redirectAsked,
  redirectPaths,
  redirectRefused,
  resolved,
  statementRedirects,
  statementStdin,
  unownedRedirects,
  type Refused,
} from './admission.ts'
import {
  HOOK_VARS,
  innerLines,
  isHook,
  programLines,
  innerReadable,
  readWord,
  readsOfTest,
  runsFunction,
  wordValue,
  type InnerLine,
  type Word,
} from './inner_lines.ts'
import {
  type Frame,
  bodyFrame,
  argvFrame,
  definitionFrame,
  gateFrame,
  lineFrame,
  occurrenceIn,
  rootFrame,
  segmentFrames,
  wholeOccurrence,
} from './occurrence.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'

// Why the gate refuses, under a rule, a command that runs lines it cannot
// see into: a sourced file, a script, a bash option mirage does not read.
export const UNREADABLE_LINES = 'runs lines the gate cannot read'
export const HOME_VAR: ReadonlySet<string> = new Set(['HOME'])
// Builtins that store into the variables they name, with their options that
// take a value.
const STORES: ReadonlyMap<string, string> = new Map([
  ['read', 'adinNptu'],
  ['mapfile', 'dnOsuCc'],
  ['readarray', 'dnOsuCc'],
  ['getopts', ''],
])
// The declarations whose `-n` makes a nameref (`export -n` unexports).
const NAMEREFS: ReadonlySet<string> = new Set(['declare', 'typeset', 'local'])
const DECLARES: ReadonlySet<string> = new Set([...NAMEREFS, 'export', 'readonly'])
// An unquoted `~` bash expands after an assignment-shaped word's `=` or `:`.
const ASSIGNED_TILDE = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^~'"\\]*[:=])?~/

/**
 * Commands that move the shell's cwd where the walk cannot follow: a line
 * run in this shell, and the directory stack.
 */
const CWD_MOVERS: ReadonlySet<string> = new Set(['eval', '.', 'source', 'pushd', 'popd'])

/**
 * Words after which a function the line defined may no longer be one, or
 * that run text in this shell the walk does not read as the line's:
 * `unset`, a line run in this shell, a trap's action.
 */
const FUNCTION_DROPPERS: ReadonlySet<string> = new Set(['unset', 'eval', '.', 'source', 'trap'])

/** The nodes a word is spelled with, quoted or not. */
const WORD_TYPES: ReadonlySet<string> = new Set([
  NodeType.WORD,
  NodeType.CONCATENATION,
  NodeType.STRING,
  NodeType.RAW_STRING,
  NodeType.ANSI_C_STRING,
  NodeType.TRANSLATED_STRING,
])

/**
 * How many other places a line may stand in before the walk calls its cwd
 * lost: each relative `cd` doubles them.
 */
const PLACES_LIMIT = 8

/**
 * How the explanation tree names a parse node that shapes a line; a node
 * not here (a redirected or negated statement) is read through. Mirrors
 * the Python SHAPES.
 */
const SHAPES: ReadonlyMap<string, string> = new Map([
  [NodeType.LIST, 'list'],
  [NodeType.PIPELINE, 'pipeline'],
  [NodeType.SUBSHELL, 'subshell'],
  [NodeType.COMPOUND_STATEMENT, 'group'],
  [NodeType.IF_STATEMENT, 'group'],
  [NodeType.FOR_STATEMENT, 'group'],
  [NodeType.WHILE_STATEMENT, 'group'],
  [NodeType.CASE_STATEMENT, 'group'],
  [NodeType.FUNCTION_DEFINITION, 'group'],
])

/** How strict an outcome is, for a line's summary: the strictest part of the line speaks for it. Mirrors the Python STRICTNESS. */
const STRICTNESS: ReadonlyMap<Outcome, number> = new Map([
  [Outcome.ALLOW, 0],
  [Outcome.ASK, 1],
  [Outcome.DENY, 2],
])

/** Nodes a list of statements holds that run nothing. Mirrors the Python INERT. */
const INERT: ReadonlySet<string> = new Set(['comment', 'heredoc_body'])

/**
 * The nodes the shell may open a redirect for that no command owns
 * (`openedBy`): a bare redirect, the statements a redirect binds to whole,
 * and an assignment. Mirrors the Python OPENERS.
 */
const OPENERS: ReadonlySet<string> = new Set([
  NodeType.REDIRECTED_STATEMENT,
  NodeType.COMPOUND_STATEMENT,
  NodeType.SUBSHELL,
  NodeType.IF_STATEMENT,
  NodeType.WHILE_STATEMENT,
  NodeType.FOR_STATEMENT,
  NodeType.C_STYLE_FOR_STATEMENT,
  NodeType.CASE_STATEMENT,
  NodeType.VARIABLE_ASSIGNMENT,
  NodeType.VARIABLE_ASSIGNMENTS,
  NodeType.DECLARATION_COMMAND,
  NodeType.UNSET_COMMAND,
])

/** The redirects a redirected statement carries after its body. Mirrors the Python REDIRECT_TYPES. */
const REDIRECT_TYPES: ReadonlySet<string> = new Set([
  NodeType.FILE_REDIRECT,
  NodeType.HEREDOC_REDIRECT,
  NodeType.HERESTRING_REDIRECT,
])

/**
 * What the gate decides about one command of a line, as the pass reads
 * it: the per-command record `explain` and the admission pass share,
 * which `explainedLine` turns into the public tree. `outcome` is the
 * document's answer and `rule` says who gave it; a line a closed tree
 * names nothing for arrives as `DENY` with the root's own leaf as its
 * rule, at 126. Mirrors the
 * Python Judgment.
 */
export interface Judgment {
  /** The head word, as the gate read it. */
  readonly command: string
  /** The words after it. */
  readonly argv: readonly string[]
  /** What the profile's rules say. */
  readonly outcome: Outcome
  /** The leaf that spoke, null when a coded condition did or nothing did. */
  readonly rule: CommandRule | null
  /** The rule's reason, empty when there is no rule. */
  readonly reason: string
  /** Where in the document the rule was written. */
  readonly source: string
  /** The operand a path-scoped rule matched, as typed. */
  readonly matchedPath: string | null
  /** The paths the rules were shown, after the session's hides. */
  readonly paths: readonly string[]
  /** What the line would exit with, 0 to run. */
  readonly exitCode: number
  /** What the agent would read, empty to run. */
  readonly stderr: string
  /** The record the refused result would carry, null when the line would run. */
  readonly decision: PolicyDecision | null
  /** Every policy's answer to the command, in the order the chain asks them. */
  readonly answers: readonly (Deny | Ask | Route)[]
  /** The command line word by word, each with its kind and the path it names, redirect targets last. */
  readonly words: readonly CommandWord[]
}

/**
 * One command of a walked line, as both readers of the line see it: its
 * words, the redirect targets of its statement, the session it is
 * judged in, and where it stands. Mirrors the Python Walked. `lost`
 * says a `cd` the walk could not follow ran before the command, so the
 * session's cwd is not where it stands. `stated` (true when absent) says
 * whether the gate admits the command on these words once each is literal
 * (`TestRead.stated`). `elsewhere` holds the other places the command may
 * stand, where a `cd` before it was skipped or failed. `deferred` says the
 * command stands in a function body, which runs where the function is
 * called, not where the walk reads the definition.
 */
export interface Walked {
  readonly words: readonly Word[]
  readonly redirects: readonly Word[]
  readonly session: SessionState
  readonly occurrence: Occurrence
  readonly intrinsic?: boolean
  readonly lost?: boolean
  readonly stdin?: Uint8Array | null
  readonly stated?: boolean
  readonly elsewhere?: readonly SessionState[]
  readonly open?: boolean
  readonly pipeline?: PipelineWalk | undefined
  readonly deferred?: boolean
}

/**
 * One command's explanation and where the command stands. The
 * occurrence is what the pass hands the ledger beside the explanation:
 * a grant claimed for the command is bound to it, so the gate that runs
 * the same occurrence finds it and no other reader does. `stated` says
 * whether the gate will read the command in the words the pass read:
 * every word literal, and no operand the runtime appends. The gate
 * reads `cat $F` as the path `$F` expands to and `xargs cat` as `cat`
 * plus the items on its stdin, so a question the pass asked about
 * either spelling would be answered for words that never run, and the
 * gate would ask again about the words that do. Such a command is
 * judged here for a deny, which speaks on the name alone, and asked
 * about at the gate. `unread` holds the paths no policy was shown
 * (`unreadPaths`), so a pass that asks the gate again asks about what
 * this explanation judged.
 */
export interface Judged {
  readonly judgment: Judgment
  readonly occurrence: Occurrence
  readonly intrinsic?: boolean
  readonly stated: boolean
  readonly unread?: ReadonlySet<string>
  /**
   * The context the chain was shown, absent for a command refused before
   * it, so the pass that admits the line before placement can put the
   * command's question to the ledger without asking the chain again.
   */
  readonly ctx?: CommandContext
  /**
   * The session the command was judged in, set beside `ctx`: for a command
   * a line runs in turn (`eval`), the one its own walk reached, so a `cd`
   * before it in that line is where it stands.
   */
  readonly session?: SessionState
  /**
   * The word calls a function the line surely defines before it runs
   * (`withCalls`), so the gate, which sees the call, says whether a tree
   * root's own decision speaks for it (`isTool`).
   */
  readonly defined?: boolean
  /**
   * The walk knows where the command stands: it is not in a function body,
   * which runs where it is called, and no `cd` the walk could not follow,
   * nor one that may have been skipped or failed, ran before it
   * (`Walked.lost`, `Walked.elsewhere`, `Walked.deferred`), so `ctx.cwd` is
   * the shell's.
   * Absent means known.
   */
  readonly placed?: boolean
}

/**
 * A redirect no command owns (`{ cat; } < f`, `> f`), as the dry run judges
 * it: what opening its target would do (`command` empty), and where the
 * node it opens for stands. Mirrors the Python Opened.
 */
export interface Opened {
  readonly judgment: Judgment
  readonly occurrence: Occurrence
}

/**
 * Where a scope leaves the shell: the session, whether a `cd` the walk could
 * not follow lost the cwd, and the other places a `cd` that may have been
 * skipped or failed leaves it.
 */
type Stand = [SessionState, boolean, readonly SessionState[]]

/**
 * A walk yields each command and returns where its scope ends. That is how
 * a `cd` reaches the commands after it without escaping the child shell it
 * ran in.
 */
type Walk = Generator<Walked, Stand>

/**
 * The paths a command's words may name that the pass cannot vouch for:
 * what a word only the runtime expands names, and, once a `cd` lost the
 * cwd, the cwd and what every relative word names. Judged as typed in
 * the cwd the pass last knew, a glob in a rule matched them and refused
 * lines that touch only allowed files. A path some word names outright as
 * a path stays read: `rm -rf /data/old` names `/data/old` even when that
 * is the cwd a `cd` lost, while the pattern in `grep -r -e /data/old`
 * names no path at all. `kinds` holds the same words classified, a path
 * as a PathSpec.
 */
function unreadPaths(
  words: readonly Word[],
  kinds: readonly (string | PathSpec)[],
  cwd: string,
  lost: boolean,
): Set<string> {
  const unread = new Set(lost ? [cwd] : [])
  const read = new Set<string>()
  words.forEach((w, i) => {
    const value = wordValue(w)
    const kind = kinds[i]
    if (w.text === null || (lost && !value.startsWith('/'))) unread.add(resolvePath(value, cwd))
    else if (kind instanceof PathSpec) read.add(kind.virtual)
  })
  for (const path of read) unread.delete(path)
  return unread
}

/** The explanation of a command the gate refuses outright. */
function denied(command: string, reason: string): Judgment {
  const deny: Deny = { kind: 'deny', reason }
  const [stderr, exitCode] = renderDeny(command, deny)
  return {
    command,
    argv: [],
    outcome: Outcome.DENY,
    rule: null,
    reason,
    source: '',
    matchedPath: null,
    paths: [],
    exitCode,
    stderr: decodeText(stderr),
    decision: decisionOf(deny),
    answers: [],
    words: [],
  }
}

/** Why the gate refuses a word only the runtime can expand. */
export function unreadable(raw: string): string {
  return `cannot read ${raw} before the runtime expands it`
}

/**
 * One command's explanation, read off the answers the gate's chain gave
 * and rendered from the same table the gate renders a refusal with: the
 * profile's rules (`PermissionsPolicy`) say the outcome and the rule that
 * spoke, the chain's answer what the line would do.
 *
 * An Ask reads the session's standing grants and stops there
 * (`Decisions.held`): a dry run must not spend one, record a question
 * or reach the host. An answer that already covers the ask leaves the
 * outcome ASK, because that is what the document says, with exit 0,
 * because that is what the line would do.
 */
async function explained(
  ctx: CommandContext,
  registry: MountRegistry,
  asked: Deny | Ask | null,
  answers: readonly (Deny | Ask | Route)[],
): Promise<Judgment> {
  const document = settled(
    answers.filter(
      (a): a is Deny | Ask => a.kind !== 'route' && a.policy === PermissionsPolicy.name,
    ),
  )
  const rule = document?.rule ?? null
  const base: Judgment = {
    command: ctx.command,
    argv: ctx.argv,
    outcome:
      document === null ? Outcome.ALLOW : document.kind === 'deny' ? Outcome.DENY : Outcome.ASK,
    rule,
    reason: document?.reason ?? '',
    source: rule !== null ? sourceOf(rule) : document !== null ? 'commands' : '',
    matchedPath: document?.kind === 'deny' ? (document.path ?? null) : null,
    paths: ctx.paths.map((p) => p.virtual),
    exitCode: 0,
    stderr: '',
    decision: null,
    answers,
    words: [],
  }
  const action: Deny | Pending | null =
    asked !== null && asked.kind === 'ask' ? await registry.decisions.held(ctx, asked) : asked
  if (action === null) return base
  const [stderr, exitCode] = await renderCommandDeny(ctx.command, action, ctx)
  return {
    ...base,
    reason: base.reason === '' ? action.reason : base.reason,
    exitCode,
    stderr: decodeText(stderr),
    decision: decisionOf(action),
  }
}

/**
 * Why a runtime that takes the line whole may not run a command the chain
 * did not refuse, null when it may. Such a runtime expands, walks, globs and
 * changes directory on its own (a remote sandbox's own disk, a host
 * process), where no entry gate follows an I/O below the judged words, so a
 * command a rule reads must not reach it with any of them in hand. A command
 * a path or mount rule reads is refused when it walks (`find`, `grep -r`,
 * `tar -c`) or names a glob; one a rule reads the arguments of when a word
 * only the runtime can expand (a parameter, a substitution, an unquoted glob)
 * stands among them, when the runtime appends operands (`xargs`,
 * `find -exec`) or when it runs after a `cd` the walk could not follow; and
 * any command, under any rule, that runs lines the gate cannot read (a
 * sourced file, a script, `eval "$p"`). A user policy answering `preCommand`
 * (in code, or a profile's program) is shown every command's expanded words
 * off such a runtime, so here it refuses as a rule that reads every command's
 * arguments does; it is never shown a walk's files, so a walk stays. With
 * neither in force nothing is refused on this account. `words` are the
 * command's words, name first, and the statement's redirect targets, as the
 * gate read them; `operands` the words after the name, classified; `coded` whether a policy
 * other than Mirage's own answers `preCommand` for the session; `cwd` the
 * working directory the line runs in. Mirrors the Python `_line_decision`.
 */
function lineDecision(
  name: string,
  args: readonly string[],
  words: readonly Word[],
  operands: readonly (string | PathSpec)[],
  redirects: readonly PathSpec[],
  inners: readonly InnerLine[],
  rules: AdmissionRules | null,
  coded: boolean,
  open: boolean,
  lost: boolean,
  cwd: string,
): string | null {
  if (scopesPaths(rules, name)) {
    if (lineFacts(name, [name, ...args], cwd).readsSubtree) {
      return 'walks a tree the gate cannot follow'
    }
    const globby = [...operands, ...redirects].some(
      (p) => p instanceof PathSpec && isGlob(p.rawPath || p.virtual),
    )
    if (globby) return 'expands a pattern only the runtime can read'
  }
  if (coded || readsArgs(rules, name)) {
    const unread = words.find((w) => w.text === null || w.glob === true)?.raw
    if (unread !== undefined) return unreadable(unread)
    if (open) return 'runs on operands the gate cannot read'
    if (lost) return 'runs after a cd the gate cannot follow'
  }
  if ((coded || hasRules(rules)) && inners.some((inner) => !innerReadable(inner))) {
    return UNREADABLE_LINES
  }
  return null
}

/** How a static read asks the policy chain and where its judgment is used. */
export const JudgmentMode = {
  PREPASS: 'prepass',
  EXPLAIN: 'explain',
  WHOLE_LINE: 'whole_line',
  EXPLAIN_WHOLE_LINE: 'explain_whole_line',
} as const
export type JudgmentMode = (typeof JudgmentMode)[keyof typeof JudgmentMode]

function takesWholeLine(mode: JudgmentMode): boolean {
  return mode === JudgmentMode.WHOLE_LINE || mode === JudgmentMode.EXPLAIN_WHOLE_LINE
}

/**
 * Judge one command and whatever lines it runs in turn, each with its
 * occurrence, one at a time, so a reader that stops at a refusal never asks
 * the chain about what comes after it. The redirect targets are read as
 * words of the command: the shell opens them on its own fds, outside the
 * window the command's own gate covers, so a rule about `/protected` sees
 * `echo x > /protected` only if they are passed here; they are empty for a
 * command with none and for the inner lines a command runs. A line the
 * command runs (`eval`, `sh -c`) is parsed on its own and read under the
 * command's occurrence, exactly as the nested evaluation will stand when it
 * runs. For a runtime that takes the line whole this is the gate itself
 * (`admitLine`), so what `explain` says about such a line is what its
 * admission does: a deny first, then what the runtime would do past the gate
 * (`lineDecision`), then an ask.
 */
async function* judgeWords(
  item: Walked,
  mode: JudgmentMode,
  registry: MountRegistry,
  namespace: Namespace | null,
  reparse: (line: string) => TSNodeLike,
): AsyncGenerator<Judged> {
  const {
    occurrence,
    session,
    stated = true,
    intrinsic = false,
    lost = false,
    stdin = null,
    open = false,
  } = item
  const placed = !lost && (item.elsewhere ?? []).length === 0 && item.deferred !== true
  const wholeLine = takesWholeLine(mode)
  const words = wholeLine ? item.words.map(machineWord) : item.words
  const redirectWords = wholeLine ? item.redirects.map(machineWord) : item.redirects
  const head = words[0]
  if (head === undefined) return
  const rules = session.commands
  // The runtime runs the commands itself: no command's result comes back
  // for a postCommand policy to judge.
  if (wholeLine && (await registry.policies.wantsFor('postCommand', session.sessionId))) {
    const reason = 'a post_command policy cannot judge a line a runtime runs whole'
    yield { judgment: denied(head.raw, reason), occurrence, stated: false, placed }
    return
  }
  if (head.text === null && !wholeLine) return
  if (wholeLine && (head.text === null || head.glob === true) && hasRules(rules)) {
    yield { judgment: denied(head.raw, unreadable(head.raw)), occurrence, stated: false, placed }
    return
  }
  const literal = stated && [...words, ...redirectWords].every((w) => w.text !== null)
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const classified = await classifiedWords(name, args, session, registry)
  const readWords = [...words.slice(1), ...redirectWords]
  const kinds = [
    ...classified.slice(1),
    ...redirectWords.map((w) => classifyBarePath(wordValue(w), registry, session.cwd)),
  ]
  const unread = unreadPaths(readWords, kinds, session.cwd, lost && !wholeLine)
  const redirects = redirectPaths(redirectWords, registry, session.cwd)
  const [ctx, asked, answers] = await gate(
    name,
    args,
    classified.slice(1),
    session,
    registry,
    namespace,
    stdin,
    redirects,
    intrinsic,
    unread,
    mode === JudgmentMode.EXPLAIN || mode === JudgmentMode.EXPLAIN_WHOLE_LINE,
    mode === JudgmentMode.PREPASS,
    occurrence.source,
  )
  // After a lost cd, a relative path names no file the pass can place.
  // Mirage's shell judges a trap's action when it fires.
  const inners =
    runsFunction(name, session, registry) || (name === 'trap' && !wholeLine)
      ? []
      : lost && !name.startsWith('/')
        ? innerLines(name, words.slice(1))
        : programLines(
            words,
            session,
            registry,
            namespace === null ? null : namespace.sessionLinks(session),
            open,
          )
  const coded =
    wholeLine && (await registry.policies.wantsFor('preCommand', session.sessionId, true))
  const refused =
    wholeLine && asked?.kind !== 'deny'
      ? lineDecision(
          name,
          args,
          [head, ...readWords],
          classified.slice(1),
          redirects,
          inners,
          rules,
          coded,
          open,
          lost,
          session.cwd,
        )
      : null
  if (refused !== null) {
    yield {
      judgment: { ...denied(name, refused), words: ctx.words ?? [] },
      occurrence,
      stated: literal,
      intrinsic,
      unread,
      placed,
    }
    return
  }
  yield {
    judgment: { ...(await explained(ctx, registry, asked, answers)), words: ctx.words ?? [] },
    occurrence,
    stated: literal,
    intrinsic,
    unread,
    ctx,
    session,
    placed,
  }
  // env's command runs in the environment env builds for it, and a nested
  // shell's line in a new shell started from this one.
  const child = name === 'env' && inners.length > 0 ? envChild(args, session) : null
  const named = name === 'command' || name.includes('/') ? inners[0]?.argv[0] : undefined
  const masked = named === undefined ? undefined : wordValue(named)
  let innerSession = session
  if (child !== null && typeof child !== 'string') {
    innerSession = session.fork()
    innerSession.vars = envVars(session, child[1])
  } else if ((name === 'sh' || name === 'bash') && inners.length > 0) {
    innerSession = session.newShell()
  } else if (masked !== undefined) {
    innerSession = session.fork()
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete innerSession.functions[masked]
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete innerSession.aliases[masked]
  }
  const pipeline =
    item.pipeline === undefined || name === 'sh' || name === 'bash'
      ? undefined
      : { ...item.pipeline }
  for (const inner of inners) {
    if (!innerReadable(inner)) continue
    if (inner.line !== null) {
      for await (const one of judgeLine(
        reparse(inner.line),
        innerSession,
        registry,
        namespace,
        reparse,
        lineFrame(inner.line, occurrence),
        mode,
        { stated: literal && !inner.open, lost, open: inner.open, pipeline },
      )) {
        yield placed ? one : { ...one, placed: false }
      }
    } else {
      const within = wholeOccurrence(argvFrame(inner.argv.map(wordValue), occurrence))
      // `env -C` runs its command where `cd` would have gone.
      const [place, moved] =
        inner.chdir === undefined || inner.chdir === null
          ? [innerSession, lost]
          : afterCd([{ raw: 'cd', text: 'cd' }, inner.chdir], innerSession, lost, [])
      for await (const one of judgeWords(
        {
          words: inner.argv,
          redirects: [],
          occurrence: within,
          session: place,
          stated: literal && !inner.open,
          lost: moved,
          open: inner.open,
          pipeline,
        },
        mode,
        registry,
        namespace,
        reparse,
      )) {
        yield placed ? one : { ...one, placed: false }
      }
    }
  }
}

/** One command node's words, name first, the env prefix dropped. */
function wordsOf(node: TSNodeLike, homes: Readonly<Record<string, string>> | null): Word[] {
  const [, parts] = splitEnvPrefix(getParts(node))
  return parts.map((part) => readWord(part, homes))
}

/**
 * The session a command runs in: `session` with the command's own
 * `NAME=value` prefix exported, as the executor seeds it before the
 * command's gate, so `preExecute` reads the environment `preCommand`
 * will. A value only the run expands is read as typed, as the command's
 * words are, and a readonly name is left as it is.
 */
function seeded(
  node: TSNodeLike,
  session: SessionState,
  homes: Readonly<Record<string, string>> | null,
): SessionState {
  const [assigned] = splitEnvPrefix(getParts(node))
  if (assigned.length === 0) return session
  const forked = session.fork()
  for (const part of assigned) {
    const text = getText(part)
    const eq = text.indexOf('=')
    if (eq < 0) continue
    const key = text.slice(0, eq)
    if (envIsReadonly(forked, key, false)) continue
    const value = part.namedChildren.find((c) => c.type !== NodeType.VARIABLE_NAME)
    seedVar(
      forked,
      key,
      value !== undefined ? wordValue(readWord(value, homes)) : text.slice(eq + 1),
    )
    setAttr(forked, key, VarAttr.Export)
  }
  return forked
}

interface PipelineWalk {
  readonly wholeLine: boolean
  readonly background: boolean
  optionsMayChange: boolean
  functions: ReadonlySet<string>
}

/** Detect option edits the walk cannot assume ran, or successfully changed the shell. */
function changesPipelineOptions(
  words: readonly Word[],
  session: SessionState,
  pipeline: PipelineWalk,
): boolean {
  const first = words[0]
  if (first === undefined) return false
  const name = first.text
  if (
    name === null ||
    first.glob === true ||
    pipeline.functions.has(name) ||
    Object.hasOwn(session.functions, name)
  )
    return true
  let index = 0
  while (words[index]?.text === 'builtin' || words[index]?.text === 'command') {
    index += words[index + 1]?.text === '--' ? 2 : 1
  }
  const head = words[index]?.text
  if (head === null || words[index]?.glob === true) return true
  if (head !== 'shopt' && head !== 'set') return false
  const operands = words.slice(index + 1)
  if (operands.some((word) => word.text === null || word.glob === true)) return true
  const args = operands.map(wordValue)
  if (head === 'shopt') {
    const scan = scanOptions(args, 'pqosu')
    const option = scan.letters.includes('o') ? 'monitor' : 'lastpipe'
    return (
      scan.bad === null &&
      scan.letters.includes('s') !== scan.letters.includes('u') &&
      scan.operands.includes(option)
    )
  }
  for (let i = 0; i < args.length;) {
    const arg = args[i]
    if (arg === undefined) break
    const word = parseOptionWord(arg, args[i + 1] ?? null)
    if (word === null) break
    if (word.settings.some(([option]) => option === 'monitor')) return true
    i += word.consumed
  }
  return false
}

function pipelineWalk(wholeLine = false): PipelineWalk {
  return {
    wholeLine,
    background: !wholeLine && currentCaller().process?.pipeline === true,
    // A runtime taking a raw line does not receive the workspace shell's options.
    optionsMayChange: wholeLine,
    functions: new Set(),
  }
}

function stageForks(
  last: boolean,
  session: SessionState,
  pipeline: PipelineWalk,
  possible = false,
): boolean {
  return pipelineStageForks(last, {
    lastpipe: pipeline.optionsMayChange ? possible : session.shopts.lastpipe === true,
    monitor: pipeline.optionsMayChange ? !possible : session.shellOptions.monitor === true,
    backgroundPipeline: pipeline.background,
  })
}

/**
 * Every command under one node, in source order, each with the session
 * it is judged in; returns the session the node leaves behind.
 *
 * A `cd` reaches the commands after it, and how far is the whole
 * question. Pinned against bash: `( )`, `$( )` and `<( )` run their
 * contents in a child shell, so a `cd` inside one applies to the rest of
 * that child and is gone when it exits; a pipeline forks its stages,
 * except for a last stage running in the caller through `lastpipe`.
 * A job runs in a fork, while a brace group or `if` body shares its shell. Reading a subshell
 * as "no `cd` applies" rather than "no `cd` escapes" judged
 * `(cd d && tar -c ..)` at the wrong directory, which made `..` read as
 * a mount root.
 *
 * The session is returned rather than carried down because that is what
 * "escapes" means, and because `&` is not a wrapper node: it is a token
 * following its command, visible only to whoever holds the sibling list.
 */
function* walkSubstitution(
  tree: TSNodeLike,
  session: SessionState,
  homes: Readonly<Record<string, string>> | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  pipeline: PipelineWalk,
  lost: boolean,
  elsewhere: readonly SessionState[],
): Walk {
  const redirect = inputSubstitutionRedirect(tree)
  if (redirect === null) {
    return yield* walkNode(tree, session, homes, frame, reparse, pipeline, lost, elsewhere)
  }
  const target = redirect.targetNode as TSNodeLike
  yield {
    words: [{ raw: 'cat', text: 'cat' }],
    redirects: [{ raw: getText(target), text: literalWord(target, homes) }],
    session,
    occurrence: occurrenceIn(tree, frame),
    intrinsic: true,
    lost,
    elsewhere,
    pipeline,
  }
  yield* walkNode(target, session, homes, frame, reparse, pipeline, lost, elsewhere)
  return [session, lost, elsewhere]
}

function* walkNode(
  node: TSNodeLike,
  session: SessionState,
  homes: Readonly<Record<string, string>> | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  pipeline: PipelineWalk,
  lost = false,
  elsewhere: readonly SessionState[] = [],
): Walk {
  const scope = scopeKind(node)
  if (scope === ScopeKind.DEFERRED) {
    frame = definitionFrame(node, frame)
    pipeline.functions = new Set([...pipeline.functions, getFunctionName(node)])
    pipeline = { ...pipeline }
  }
  const opened =
    OPENERS.has(node.type) || (node.type === NodeType.COMMAND && getText(node).startsWith('exec'))
      ? openedBy(node, homes)
      : []
  if (opened.length > 0) {
    // The files the shell opens for no command as it reaches the node,
    // where it stands: no command's words, so only a walk that asks for
    // them sees them (`walkedLine`).
    yield {
      words: [],
      redirects: opened,
      session,
      occurrence: occurrenceIn(node, frame),
      lost,
      elsewhere,
      pipeline,
    }
  }
  if (node.type === NodeType.TEST_COMMAND) {
    // The shell's own test, judged as a command of its own name, a test at
    // a time as the gate admits it.
    for (const test of readsOfTest(node, homes)) {
      yield {
        words: test.words,
        redirects: statementRedirects(node, homes),
        stdin: statementStdin(node),
        session,
        occurrence: occurrenceIn(node, frame),
        intrinsic: true,
        lost,
        stated: test.stated,
        elsewhere,
        pipeline,
      }
    }
    for (const child of node.children) {
      yield* walkNode(child, session, homes, frame, reparse, pipeline, lost, elsewhere)
    }
    return [session, lost, elsewhere]
  }
  if (node.type === NodeType.COMMAND) {
    let walked: Stand = [session, lost, elsewhere]
    const words = wordsOf(node, homes)
    if (words.length > 0) {
      yield {
        words,
        redirects: statementRedirects(node, homes),
        stdin: statementStdin(node),
        session: seeded(node, session, homes),
        occurrence: occurrenceIn(node, frame),
        lost,
        elsewhere: elsewhere.map((e) => seeded(node, e, homes)),
        pipeline,
      }
      walked = afterCd(words, session, lost, elsewhere)
    }
    // A substitution among the words runs in its own shell.
    for (const child of node.children) {
      yield* walkNode(child, session, homes, frame, reparse, pipeline, lost, elsewhere)
    }
    if (!pipeline.optionsMayChange) {
      pipeline.optionsMayChange = changesPipelineOptions(words, session, pipeline)
    }
    return walked
  }
  if (scope === ScopeKind.FORK || scope === ScopeKind.SUBSTITUTION) {
    const childPipeline = { ...pipeline, background: false }
    // A substitution's body is walked in a frame of its own: the nested
    // line that evaluates it parses the body alone, under the
    // substitution's node, and the commands in it have to be placed
    // here exactly where that line will place them.
    const segments = segmentFrames(node, frame)
    if (segments.length > 0) {
      // A backtick region is read as the evaluator runs it: its body
      // parsed again once its backslashes are gone, because the node's
      // subtree is not what runs.
      for (const inner of segments) {
        yield* walkSubstitution(
          reparse(inner.text),
          session,
          homes,
          inner,
          reparse,
          childPipeline,
          lost,
          elsewhere,
        )
      }
      return [session, lost, elsewhere]
    }
    const inner = bodyFrame(node, frame)
    if (node.type === NodeType.COMMAND_SUBSTITUTION && inner !== null) {
      const body = { ...inner, base: 0 }
      yield* walkSubstitution(
        reparse(inner.text),
        session,
        homes,
        body,
        reparse,
        childPipeline,
        lost,
        elsewhere,
      )
      return [session, lost, elsewhere]
    }
    yield* walkChildren(
      node,
      session,
      homes,
      inner ?? frame,
      reparse,
      childPipeline,
      lost,
      elsewhere,
    )
    return [session, lost, elsewhere]
  }
  if (scope === ScopeKind.PIPELINE) {
    const stages = node.namedChildren
    let ended: Stand = [session, lost, elsewhere]
    for (const [index, child] of stages.entries()) {
      const last = index === stages.length - 1
      const forked = stageForks(last, session, pipeline)
      const childPipeline = forked ? { ...pipeline, background: false } : pipeline
      const after = yield* walkNode(
        child,
        session,
        homes,
        frame,
        reparse,
        childPipeline,
        lost,
        elsewhere,
      )
      if (!forked) {
        ended = after
      } else if (
        pipeline.optionsMayChange &&
        !stageForks(last, session, pipeline, true) &&
        (pipeline.wholeLine || after[0] !== session || after[1] !== lost)
      ) {
        // The final stage may change the caller's cwd. The workspace has a
        // live command gate. For a whole line, judge every cwd we can place.
        if (pipeline.wholeLine && !after[1]) {
          const places = new Map<string, SessionState>()
          for (const place of [...elsewhere, after[0], ...after[2]]) {
            if (place.cwd !== session.cwd && !places.has(place.cwd)) places.set(place.cwd, place)
          }
          ended =
            places.size <= PLACES_LIMIT
              ? [session, lost, [...places.values()]]
              : [session, true, elsewhere]
        } else {
          ended = [session, true, elsewhere]
        }
      }
    }
    return ended
  }
  if (
    (scope === ScopeKind.REPEATED || scope === ScopeKind.DEFERRED) &&
    moves(node, session, homes, pipeline)
  ) {
    lost = true
  }
  const walk = walkChildren(node, session, homes, frame, reparse, pipeline, lost, elsewhere)
  return yield* scope === ScopeKind.DEFERRED ? deferred(walk) : walk
}

/**
 * A function body's walk, each command marked as standing in it
 * (`Walked.deferred`). Mirrors the Python `_deferred`.
 */
function* deferred(walk: Walk): Walk {
  for (;;) {
    const next = walk.next()
    if (next.done === true) return next.value
    yield { ...next.value, deferred: true }
  }
}

/**
 * Whether a command in a scope may move the shell's cwd, outside the child
 * shells it forks (a subshell, a substitution, a pipeline's stages, a job sent
 * to the background), as `walkNode` reads them: what a loop or a function
 * body carries into its next run. Read off the tree, so a nested scope costs
 * one more scan, not another walk.
 */
function moves(
  node: TSNodeLike,
  session: SessionState,
  homes: Readonly<Record<string, string>> | null,
  pipeline: PipelineWalk,
): boolean {
  const stack: [TSNodeLike, boolean][] = [[node, false]]
  let movedInLastStage = false
  let changesOptions = false
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [current, needsLastpipe] = entry
    const scope = scopeKind(current)
    if (scope === ScopeKind.FORK || scope === ScopeKind.SUBSTITUTION) continue
    if (scope === ScopeKind.PIPELINE) {
      const last = current.namedChildren.at(-1)
      if (last !== undefined && !pipeline.background) {
        stack.push([last, needsLastpipe || stageForks(true, session, pipeline, true)])
      }
      continue
    }
    if (current.type === NodeType.COMMAND) {
      const words = wordsOf(current, homes)
      if (words.length > 0) {
        changesOptions ||= changesPipelineOptions(words, session, pipeline)
        const [moved, lost] = afterCd(words, session, false, [])
        if (lost || moved !== session) {
          if (!needsLastpipe) return true
          movedInLastStage = true
        }
      }
    }
    for (const child of current.children) {
      if (!isBackgrounded(child)) stack.push([child, needsLastpipe])
    }
  }
  return movedInLastStage && changesOptions
}

/**
 * One scope's children in order, threading the cwd between them; returns
 * where the scope ends.
 */
function* walkChildren(
  node: TSNodeLike,
  session: SessionState,
  homes: Readonly<Record<string, string>> | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  pipeline: PipelineWalk,
  lost: boolean,
  elsewhere: readonly SessionState[],
): Walk {
  let walked: Stand = [session, lost, elsewhere]
  for (const child of node.children) {
    const background = isBackgrounded(child)
    const childPipeline = background
      ? { ...pipeline, background: backgroundPipeline(child) }
      : pipeline
    const ended = yield* walkNode(
      child,
      walked[0],
      homes,
      frame,
      reparse,
      childPipeline,
      walked[1],
      walked[2],
    )
    if (!background) walked = ended
  }
  return walked
}

/**
 * Where the next command of a line stands, which differs from this one only
 * when this command moved the shell.
 *
 * `cd /repo && git commit` is judged before the line runs, so without this
 * the rule about `/repo` reads the cwd the session happened to be in and
 * answers about the wrong directory. A `cd` may also be skipped
 * (`false && cd d`) or fail, so the shell may still stand anywhere it stood
 * before: those places ride along, and a runtime that takes the line whole
 * admits a command only where every one of them does. A `cd` the walk
 * cannot follow (`cd "$d"`, `cd -`, any once the cwd is lost, since it too
 * may fail), a line run in this shell (`eval`, `source`) or the directory
 * stack loses the cwd, and what the commands after it name relative to it
 * is the per-command gate's to judge, in the real one: judged in the cwd the
 * walk last knew, `cd "$d" && rm x` refused a line that removes an allowed
 * file.
 */
function afterCd(
  words: readonly Word[],
  session: SessionState,
  lost: boolean,
  elsewhere: readonly SessionState[],
): Stand {
  const head = words[0]
  if (head === undefined) return [session, lost, elsewhere]
  const name = wordValue(head)
  if ((name === 'command' || name === 'builtin') && words.length > 1) {
    return afterCd(words.slice(1), session, lost, elsewhere)
  }
  if (CWD_MOVERS.has(name)) return [session, true, elsewhere]
  if (name !== 'cd') return [session, lost, elsewhere]
  const target = words.length === 2 ? (words[1]?.text ?? null) : null
  if (lost || target === null || target.startsWith('-')) return [session, true, elsewhere]
  const predicted = session.fork({ cwd: resolvePath(target, session.cwd) })
  const places = new Map<string, SessionState>()
  for (const place of [
    session,
    ...elsewhere,
    ...elsewhere.map((e) => e.fork({ cwd: resolvePath(target, e.cwd) })),
  ]) {
    if (place.cwd !== predicted.cwd && !places.has(place.cwd)) places.set(place.cwd, place)
  }
  if (places.size > PLACES_LIMIT) return [session, true, elsewhere]
  return [predicted, false, [...places.values()]]
}

/**
 * Every command of a line with the session it is judged in.
 *
 * The cwd is the one fact that moves as a line runs, and both readers
 * of a line need the same answer about it: a host asking what a line
 * would do and the pass deciding whether to let it run cannot differ,
 * or `explain` would report an allow the run then refuses. The redirects
 * ride along for the same reason: they are read here so both readers
 * judge the file the shell opens, not just the operands. With `opens`, each
 * statement's redirects no command owns come too, as an item with no
 * words, where the statement stands (`explainRedirects`).
 */
function* walkedLine(
  root: TSNodeLike,
  session: SessionState,
  reparse: (line: string) => TSNodeLike,
  frame: Frame | null = null,
  lost = false,
  opens = false,
  pipeline = pipelineWalk(),
  homes: Readonly<Record<string, string>> = tildeHomes(session),
): Generator<Walked> {
  for (const item of walkNode(
    root,
    session,
    homes,
    frame ?? rootFrame(root, null),
    reparse,
    pipeline,
    lost,
  )) {
    if (item.words.length > 0 || opens) yield item
  }
}

/**
 * Whether the compound-line pass puts a command through the gate.
 *
 * A verdict is, so the line is refused whole. So is a command that would
 * run, because "would run" may mean a standing grant answers its ask,
 * and only the gate can claim that grant for this line: read but not
 * claimed, one nod answered every spelling of the command on the line,
 * and a grant given to a line that was then refused stood for the next
 * one. What stays out is the rule-less DENY, which `isVerdict` explains
 * is answered where it happens.
 */
function isJudged(one: Judged): boolean {
  return one.judgment.exitCode === 0 || isVerdict(one)
}

/**
 * Whether a tree's root decided the command by its own decision, which
 * speaks for every command the tree names nothing for. A root leaf with
 * paths states a rule about those paths, and holds the line. Mirrors the
 * Python `_by_default`.
 */
function byDefault(expl: Judgment): boolean {
  const rule = expl.rule
  return rule !== null && (rule.paths ?? []).length === 0 && (rule.at ?? '').split('/')[1] === '*'
}

/**
 * Whether the leaf that decided the command belongs to a mount entry's
 * tree, and the command surely works inside that folder: a word of its own
 * names an absolute path there, or the walk knows where it stands
 * (`Judged.placed`) and its cwd or a path it reaches is there. Where the
 * walk only guesses the cwd (after `cd -`, `cd "$d"`, a `cd` that may
 * fail), the per-command gate judges the command in the cwd the shell
 * really has. Mirrors the Python `_in_folder`.
 */
function inFolder(one: Judged): boolean {
  const mount = one.judgment.rule?.mount ?? ''
  if (mount === '') return false
  const ctx = one.ctx
  if (ctx === undefined) return true
  if (
    one.placed !== false &&
    [ctx.cwd, ...ctx.paths.map((path) => path.virtual)].some((path) => underPath(path, mount))
  ) {
    return true
  }
  return (ctx.words ?? []).some(
    (word) =>
      word.path !== null && word.text.startsWith('/') && underPath(word.path.virtual, mount),
  )
}

/**
 * Whether a redirect target of the command lies in the folder of the mount
 * entry whose leaf decided it: an absolute one always, a relative one where
 * the walk knows where the command stands (`Judged.placed`), as `inFolder`
 * reads a path. Mirrors the Python `_opens_in_folder`.
 */
function opensInFolder(one: Judged): boolean {
  const mount = one.judgment.rule?.mount ?? ''
  const ctx = one.ctx
  if (mount === '' || ctx === undefined) return false
  return (ctx.words ?? []).some(
    (word) =>
      word.kind === WordKind.REDIRECT &&
      word.path !== null &&
      (one.placed !== false || word.text.startsWith('/')) &&
      underPath(word.path.virtual, mount),
  )
}

/**
 * Whether the profile refuses a command no tree names (by a root's own
 * decision, or a CLI that reaches a service, `unlistedService`), on its
 * own words, which nothing that runs before it on the line can change.
 * Mirrors the Python `_uncovered`.
 */
function uncovered(expl: Judgment): boolean {
  return (
    expl.outcome === Outcome.DENY &&
    (expl.source === 'commands' || byDefault(expl)) &&
    refuses(expl)
  )
}

/**
 * Whether an explanation refuses the command outright, rather than
 * reporting a line that would run or a question the host has not
 * answered.
 */
function refuses(expl: Judgment): boolean {
  return expl.exitCode !== 0 && !isPending(expl.decision)
}

/**
 * Whether the pass may answer a command's question on the gate's
 * behalf: it may when the gate will read the words the pass read, and a
 * deny is always the pass's to enforce, since it speaks on the name
 * alone. What is left is a question about a spelling the runtime
 * completes, which is the gate's: asked here, it would be answered for
 * words that never run.
 */
function asksFor(one: Judged): boolean {
  return one.stated || refuses(one.judgment)
}

/**
 * Whether an explanation refuses the line's intent, rather than just
 * failing one command.
 *
 * A deny a tree states for a command it names, and command-scoped policy
 * refusals, hold the line. Operand-scoped filesystem refusals wait for
 * the per-command gate, where earlier commands have established the live
 * cwd and namespace. Rule-less DENY results also wait, and so does a
 * top-level tree root's own decision (`byDefault`): an unavailable head
 * word, a command no tree names, or words only the runtime can expand
 * fail where they occur rather than against the whole line. A mount
 * entry's root speaks about its folder, as a root leaf with paths speaks
 * about those paths, so it holds the line where the command surely works
 * inside that folder (`inFolder`), except for a word the line defines as a
 * function (`Judged.defined`): the call runs the function, whose body's
 * commands are each judged, and the gate sees whether it does. The call's
 * redirect targets are not the body's: the shell opens them whatever the
 * body does, so one inside the folder (`opensInFolder`) holds the line
 * still.
 */
function isVerdict(one: Judged): boolean {
  const expl = one.judgment
  if (
    expl.exitCode === 0 ||
    (byDefault(expl) && ((one.defined === true && !opensInFolder(one)) || !inFolder(one)))
  ) {
    return false
  }
  if (expl.rule !== null && expl.outcome === Outcome.DENY) return true
  // Filesystem refusals use the live cwd and fail only their command.
  const denied = expl.answers.find((a): a is Deny => a.kind === 'deny')
  if (denied !== undefined && (denied.path !== undefined || denied.error !== undefined)) {
    return false
  }
  return expl.rule !== null || expl.outcome === Outcome.ALLOW
}

/**
 * Whether `lineJudgments` may judge two commands of `root`, the least
 * `prejudgeLine` refuses a line on. It walks the line as that pass does and
 * stops at the second command; for a line with one, that command is judged
 * once more only for the lines it runs (`eval`, `sh -c`, `env`, `xargs`,
 * `find -exec`), read as the pass reads them. False means the pass would
 * judge fewer than two commands, so a one-command line skips it and its
 * command is judged once, by the per-command gate. True only sends the line
 * through the pass, which counts again.
 */
export function mayPrejudge(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
): boolean {
  const frame = rootFrame(root, handed.origin)
  let only: Walked | null = null
  for (const item of walkedLine(root, session, reparse, frame)) {
    if (item.words[0]?.text === null) continue
    if (only !== null) return true
    only = item
  }
  if (only === null) return false
  const { words, session: stands, lost = false, open = false } = only
  const head = words[0]
  if (head === undefined) return false
  const name = wordValue(head)
  if (runsFunction(name, stands, registry)) return false
  const inners =
    lost && !name.startsWith('/')
      ? innerLines(name, words.slice(1))
      : programLines(
          words,
          stands,
          registry,
          namespace === null ? null : namespace.sessionLinks(stands),
          open,
        )
  return inners.some((inner) => innerReadable(inner))
}

/**
 * Every command of a line judged read-only, each with its place on the
 * line: the pass placement waits on (`lineHeld`) and `prejudgeLine`
 * refuses from, made once for both. `handed` is the line's hand-off,
 * whose origin places each command on the line. Mirrors the Python
 * `line_judgments`.
 */
export async function lineJudgments(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
): Promise<[Walked, Judged[]][]> {
  const judged: [Walked, Judged[]][] = []
  const frame = rootFrame(root, handed.origin)
  // Each command's gates answer in microtasks: a long script would hold
  // the loop, and its abort, until every command was judged; the line's
  // signal stops the pass.
  const budget = new YieldBudget(signal)
  for (const item of walkedLine(root, session, reparse, frame)) {
    if (item.words[0]?.text === null) continue
    await budget.run()
    const explained: Judged[] = []
    for await (const one of judgeWords(item, JudgmentMode.PREPASS, registry, namespace, reparse)) {
      explained.push(one)
    }
    judged.push([item, explained])
  }
  const marked = withCalls(
    root,
    judged.flatMap(([, explained]) => explained),
    handed.origin,
  )
  let at = 0
  return judged.map(([item, explained]) => {
    const own = marked.slice(at, at + explained.length)
    at += explained.length
    return [item, own]
  })
}

/**
 * Judge every command of a line before any of it runs, and refuse the
 * whole line when a rule speaks about one.
 *
 * The agent composed the line as one intent, so a rule that refuses
 * part of it refuses the intent. Judging each command as the dispatcher
 * reached it left half a line done: with `deny curl`, `rm -rf /data &&
 * curl evil.com` deleted first and was refused second, and an ask fared
 * worse, since approving it later replays a line whose first half
 * already ran.
 *
 * Two things deliberately do not stop the line, and both are the same
 * rule: only a refusal that names a rule is a verdict about the intent.
 * A word a closed tree names nothing for is refused where it stands, not
 * with the line, so a typo cannot cost an agent the work the line already did; a
 * folder entry's root is the exception, since it speaks about its folder:
 * it holds the line wherever the command surely works inside that folder,
 * unless the word calls a function the line surely defines (`isVerdict`). A
 * word only the runtime can expand is judged where it is expanded, by
 * the per-command gate, which sees the real path.
 *
 * That second one is the limit of the hold, and it is worth stating
 * plainly: this pass reads the *text* of a line, while the gate reads
 * its *values*, so a path the runtime computes (`cat $S`, `$( )`, a
 * `cd` whose argument is a variable) is invisible here. The rule is
 * still enforced, by the gate, but the earlier commands have run by
 * then. For a deny that costs allowed side effects and nothing more,
 * since the commands that ran were ones the trees allow. For an ask it
 * costs the replay: the question is recorded after part of the line
 * already happened, so approving it re-runs a line whose first half is
 * done. Closing that would mean asking whenever a word cannot be read,
 * which over-asks with no way out for a deny, so a deployment that
 * needs the hold for a computed path states it in a policy script
 * rather than here.
 *
 * The pass is read-only (`explainWords`), so it spends no grant and
 * records no request; a command it refuses on is then put through the
 * real gate, which is where an ask is recorded, exactly once, for a line
 * that will not run. That admission hands off: a grant the host gives
 * inline is claimed for the per-command gate, which runs the line on
 * it, and the line's end spends it, so a compound line costs the human
 * one question per run rather than one per pass, and a gate the run
 * reaches twice (a loop body) runs on one nod.
 *
 * A question is only asked here when the gate will ask the same one.
 * The gate reads a word the runtime expands as its value and the words
 * `xargs` or `find -exec` hand on with the operands the runtime
 * appends, so a question about `cat $F` or a bare `cat` would be
 * answered for words that never run and the gate would ask again, after
 * the earlier commands ran, about the words that do. Such a command
 * (`Judged.stated` false) is judged here for a deny, which speaks on
 * the name alone and still holds the line, and its question is left to
 * the gate; the hold does not reach it, which is the limit stated above
 * in another form.
 *
 * Every command is judged whether or not the session carries a document,
 * by the profile's rules alone: a policy registered in code or a profile's
 * script answers `preCommand` once, at the gate that runs the command, and
 * a line it should refuse whole is `preExecute`'s to refuse. Operand-scoped
 * refusals, including MountRootPolicy's, remain the per-command gate's
 * responsibility.
 *
 * A line with one command to judge is left to the per-command gate,
 * which is not an optimization but the more faithful answer: there is no
 * earlier command whose side effects a hold could save, and the gate
 * refuses from inside the shell, so the line's own redirections still
 * apply. This pass answers above them, so refusing `rm -rf /mnt 2>&1`
 * here wrote the refusal to stderr where bash puts it on stdout.
 */
export async function prejudgeLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  // The line's hand-off, on which every grant claimed here rides to the
  // executor's sweep.
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
  // This pass puts real questions to a host, so it carries the run's
  // kill channel exactly as the per-command gate does. Without it a
  // compound line asked here waited on an answer that its own timeout
  // could no longer cut short.
  signal?: AbortSignal,
  // The line's read-only judgments (`lineJudgments`) when placement
  // already made them, so the policies are asked once.
  made: [Walked, Judged[]][] | null = null,
): Promise<Refused | null> {
  if (made === null && !mayPrejudge(root, session, registry, namespace, handed, reparse)) {
    return null
  }
  const judged = made ?? (await lineJudgments(root, session, registry, namespace, handed, reparse))
  if (judged.reduce((n, [, explained]) => n + explained.length, 0) < 2) return null
  for (const [, explained] of judged) {
    for (const one of explained) {
      if (!isJudged(one) || !asksFor(one)) continue
      // This pass judges on the gate's behalf and runs nothing itself, so a
      // grant the host gives here is claimed for the per-command gate that
      // runs the line, and spent when the line ends: one question per run,
      // not per pass.
      const refused = await admitted(one, registry, handed, signal)
      if (refused !== null) return refused
      // The host answered this one inline. The rest of the line has not
      // been judged yet, so the scan goes on: stopping here let a later
      // command's deny run behind an approval.
    }
  }
  return null
}

/**
 * One judged command put through the ledger, as the gate puts it. A command
 * refused before any policy was asked (`Judged.ctx` absent) stands as
 * judged. Otherwise the chain's answer the judgment recorded is the gate's,
 * and its Ask is answered from the session's grants or the host and claimed
 * on the line's hand-off (`handed`, null outside a line) for this
 * occurrence, so the policies are asked once per command, by the pass that
 * judged it. Mirrors the Python `_admitted`.
 */
async function admitted(
  one: Judged,
  registry: MountRegistry,
  handed: HandOff | null,
  signal?: AbortSignal,
): Promise<Refused | null> {
  const judgment = one.judgment
  if (one.ctx === undefined) {
    return {
      stderr: encodeText(judgment.stderr),
      exitCode: judgment.exitCode,
      decision: judgment.decision,
    }
  }
  const action = await resolved(
    one.ctx,
    refusal(judgment.answers),
    registry,
    signal,
    handed === null ? null : { line: handed, occurrence: one.occurrence },
  )
  if (action === null) return null
  const [stderr, exitCode] = await renderCommandDeny(judgment.command, action, one.ctx)
  return { stderr, exitCode, decision: decisionOf(action) }
}

/**
 * Admit every command of a line a runtime takes whole. A whole line is a
 * command like any other, but the runtime does the expanding, so the gate
 * reads the line as typed, walked as `explain` walks it: each command is
 * judged on its literal words (quotes removed, escapes resolved, a
 * path-shaped word a path, an installed CLI's verb path walked) where it
 * stands, a `cd` before it on the line included, and the first refusal is
 * the line's. A statement's redirect targets are read as words of its
 * command, so `cat < /data/secret` is judged on the file it opens, and a
 * redirect no command owns (`{ cat; } < f`, `> f`) is judged on its target
 * as the shell would open it, where it stands (`admitRedirect`), so each
 * open is a nod of its own; the lines
 * a command runs (`eval`, `sh -c`, `xargs`, `env` ... see `innerLines`) are
 * judged in turn; and what the runtime would do past the gate is refused
 * under a rule, or a user `preCommand` policy, that would have read it
 * (`lineDecision`). A command a `preCommand` route places off the runtime or
 * machine the line runs whole on (`offLine`) is refused too, since one run
 * cannot put it elsewhere.
 * `reparse` parses the text a word runs the way the line reader parsed the
 * line.
 *
 * No gate follows this pass: the runtime runs the line whole, so every
 * grant it matches is claimed on the line's hand-off exactly as any reader
 * on a line claims, and the executor's sweep spends them when the line
 * ends. A line held on a question still waiting keeps its earlier answers
 * standing for the retry, exactly as the compound-line pass does, where
 * spending them here asked the human again for each on every retry.
 * `handed` is null outside a line (a bare admission with no run behind it).
 * Mirrors the Python `admit_line`.
 */
export async function admitLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
  handed: HandOff | null = null,
  offLine: ((one: Judged) => boolean) | null = null,
): Promise<Refused | null> {
  for await (const one of judgeLine(
    root,
    session,
    registry,
    namespace,
    reparse,
    rootFrame(root, handed?.origin ?? null),
    JudgmentMode.WHOLE_LINE,
  )) {
    const refused =
      (await admitted(one, registry, handed, signal)) ??
      (offLine === null ? null : await offLineRefusal(one, offLine))
    if (refused !== null) return refused
  }
  for (const [word, at] of unownedRedirects(root, tildeHomes(session))) {
    const refused = await admitRedirect(
      redirectPaths([word], registry, session.cwd),
      session,
      registry,
      namespace,
      at,
    )
    if (refused !== null) return refused
  }
  return null
}

/**
 * A command a `Deny` refuses at its own node, rendered as its run renders it,
 * while the rest of its line still runs.
 */
export function refusedWhereItStands(one: Judged, deny: Deny): Judged {
  const [stderr, exitCode] = renderDeny(one.judgment.command, deny)
  return {
    ...one,
    judgment: {
      ...one.judgment,
      outcome: Outcome.DENY,
      reason: deny.reason,
      exitCode,
      stderr: decodeText(stderr),
      decision: decisionOf(deny),
    },
  }
}

/**
 * The refusal of a command a `preCommand` route places off the runtime or
 * machine its line runs whole on (`offLine`, `Router.offLine`), which that
 * one run cannot honor; null for one that stays. Mirrors Python's
 * `off_line_refusal`.
 */
export async function offLineRefusal(
  one: Judged,
  offLine: (one: Judged) => boolean,
): Promise<Refused | null> {
  const route = commandRoute(one.judgment.answers)
  if (route === null || one.ctx === undefined || !offLine(one)) return null
  const command = one.judgment.command
  const action: Deny = {
    kind: 'deny',
    reason: `${route.policy ?? ''} routes ${command} elsewhere, and a line run whole runs in one place`,
    ...(route.policy === undefined ? {} : { policy: route.policy }),
  }
  const [stderr, exitCode] = await renderCommandDeny(command, action, one.ctx)
  return { stderr, exitCode, decision: decisionOf(action) }
}

/**
 * Whether a verdict's answer refuses the command, putting an
 * unanswered ask's question to the host.
 *
 * The rules' own answer the pass recorded is read, the first deny else
 * the first ask, the way the gate picks it. A deny refuses outright. An
 * ask's settled record is read without being spent (`Decisions.held`), so
 * the gate that then runs the line consumes the same answer, in its own
 * voice and behind the line's redirections; an unanswered rule is raised
 * through the same ledger the gate reads, so the answer lands exactly once
 * and the gate does not ask again.
 */
async function verdictRefuses(
  judged: Judged,
  registry: MountRegistry,
  // The line's hand-off, on which an answer given here is claimed for
  // the gate.
  handed: HandOff,
  signal?: AbortSignal,
  // The agent the line is attributed to, which a question raised here
  // names for the host.
): Promise<boolean> {
  const ctx = judged.ctx
  if (ctx === undefined) return true
  const asked = refusal(judged.judgment.answers)
  if (asked?.kind !== 'ask') return asked !== null
  const claimant: Claimant = { line: handed, occurrence: judged.occurrence }
  const standing = await registry.decisions.held(ctx, asked, claimant)
  if (standing === null) return false
  if (standing.kind === 'deny') return true
  // handOff: this pass exists to decide whether a secret is fetched, and the
  // gate behind it still has to admit the line. An answer given here is
  // claimed for that gate, which runs on it, so the host is asked once.
  return (await resolved(ctx, asked, registry, signal, claimant)) !== null
}

/**
 * Whether the node defines a function anywhere in its tree.
 *
 * A definition's body is walked by `walkedLine` like any other scope,
 * but it runs at invocation, not here, so a command inside one must
 * not be read as the node's own: judging it would refuse a line that
 * only stores text, and the read walks already charge nothing for it.
 */
function definesFunction(node: TSNodeLike): boolean {
  const stack = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.type === 'function_definition') return true
    for (const child of current.namedChildren) stack.push(child)
  }
  return false
}

/**
 * The node's one fully-literal command, when nothing else in the node
 * can read a name.
 *
 * A walked node's reads can be discounted only when the whole node is
 * one command, every word and redirect of it is literal, it defines
 * nothing, and its tree reads no name any other way: such a node reads
 * only what that one command's own grammar reads, so a refusal of the
 * command is a refusal of every read the node contributes. Anything
 * less provable -- a second command, a word only the runtime can
 * expand, a `$NAME` anywhere -- returns null, and the caller keeps the
 * node, because some part of it may still run and read.
 */
function soleLiteralCommand(
  node: TSNodeLike,
  session: SessionState,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
): Walked | null {
  const items = [...walkedLine(node, session, reparse, frame)]
  const item = items[0]
  if (items.length !== 1 || item === undefined) return null
  if ([...item.words, ...item.redirects].some((word) => word.text === null)) return null
  if (definesFunction(node)) return null
  if (referencedNames(node).size > 0 || opaqueReads(node)) return null
  return item
}

/**
 * Whether one walked command is refused on its text, resolving an
 * unanswered ask through the ledger the gate reads. `line` says the
 * command is the whole line, which runs nothing at all once a tree's root
 * refuses it.
 */
async function commandRefused(
  item: Walked,
  registry: MountRegistry,
  namespace: Namespace | null,
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
  line = false,
): Promise<boolean> {
  const explained: Judged[] = []
  for await (const one of judgeWords(
    { ...item, intrinsic: false },
    JudgmentMode.PREPASS,
    registry,
    namespace,
    reparse,
  )) {
    explained.push(one)
  }
  // The profile refusing the line's one command on words no glob can
  // change means nothing runs. A line it hands on, or a line handed on to
  // it, is not enough: what runs it may not ask the gate.
  const globbed = [...item.words, ...item.redirects].some((word) => word.glob === true)
  const [own] = explained
  if (line && own !== undefined && !globbed && uncovered(own.judgment)) return true
  for (const judged of explained) {
    // A question about a spelling the runtime completes is the gate's
    // (`asksFor`); the node is kept, and over-keeping only ever
    // over-fetches.
    if (!isVerdict(judged) || !asksFor(judged)) continue
    if (await verdictRefuses(judged, registry, handed, signal)) return true
  }
  return false
}

/**
 * The walked nodes whose reads an env-plane fetch still serves.
 *
 * The fill derives its fetch set from this same list (`lineNodes`: the
 * line's own tree first, then every stored body and alias expansion
 * its words can invoke), and a fetch serves a command that is going to
 * run, so refusals are judged over the same nodes reads are. One rule
 * for every node: when it is one fully-literal command with no other
 * read in it (`soleLiteralCommand`), the gate is asked here on exactly
 * the words it will read at run time, and a refusal discounts every
 * read the node contributes. The line's own refusal drops the whole
 * list, because nothing runs at all; a refused body or alias drops
 * just itself, because the invocation still runs and is refused in
 * place. A node this pass cannot prove silent is kept, and over-keeping
 * only ever over-fetches.
 *
 * An ASK is resolved rather than skipped, because the fetch is itself
 * an effect: contacting a secret store for a line the host then
 * refuses would do a piece of exactly what was refused. A settled
 * answer is read without being spent; an unanswered rule is put to the
 * host now, through the same ledger the gate reads, so the answer
 * lands exactly once -- an approval keeps the node and the gate
 * consumes the grant, while a denial or a question left waiting drops
 * it, and the line still runs into the gate, which refuses in place
 * with its wording and its redirections.
 */
export async function unrefusedNodes(
  nodes: readonly TSNodeLike[],
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  // The line's hand-off, on which an approval given here is claimed
  // for the gate.
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
): Promise<TSNodeLike[]> {
  const out: TSNodeLike[] = []
  for (const [position, node] of nodes.entries()) {
    // Each node is read in the frame of its own tree: the line's, or
    // the one a stored body was parsed from, which is the frame its gate
    // will read it in. An alias expansion is parsed here with a rest
    // word no reader can spell (`lineNodes`), so it is never one literal
    // command and its frame goes unread; its gate reads it under the
    // word that invoked it.
    const item = soleLiteralCommand(
      node,
      session,
      gateFrame(node, nodes[0] ?? node, session, handed),
      reparse,
    )
    if (item === null) {
      out.push(node)
      continue
    }
    if (await commandRefused(item, registry, namespace, handed, reparse, signal, position === 0)) {
      if (position === 0) return []
      continue
    }
    out.push(node)
  }
  return out
}

/**
 * Whether the line's admission holds it back, which is what placement
 * waits on: admission comes first, so a line the rules refuse, or that
 * waits on the host, is never shown to a placing policy. A verdict
 * (`isVerdict`) that refuses holds the line. A question is put to the
 * host now, on the line's hand-off, so the gate that later runs the
 * command finds the answer claimed for it and does not ask again; one
 * still waiting holds the line, and a question the gate will ask about
 * other words (`Judged.stated` false) is left to it. A word the allow
 * list leaves out fails where it stands while the rest of its line runs,
 * so it does not hold the line, except where a folder entry's root refuses
 * it inside that folder (`isVerdict`). Mirrors the Python `line_held`.
 */
export async function lineHeld(
  judged: readonly [Walked, Judged[]][],
  registry: MountRegistry,
  handed: HandOff,
  signal?: AbortSignal,
  // The agent the line is attributed to, which a question raised here
  // names for the host.
): Promise<boolean> {
  for (const [, explained] of judged) {
    for (const one of explained) {
      const expl = one.judgment
      if (!isVerdict(one) || expl.exitCode === 0) continue
      if (refuses(expl)) return true
      const asked = refusal(expl.answers)
      if (one.ctx === undefined || asked?.kind !== 'ask' || !one.stated) continue
      const claimant: Claimant = { line: handed, occurrence: one.occurrence }
      if ((await resolved(one.ctx, asked, registry, signal, claimant)) !== null) return true
    }
  }
  return false
}

/**
 * Whether some command's judgment is a verdict that refuses it or waits
 * on the host (`isVerdict`), the line-level answer placement waits on.
 * Mirrors the Python `holds`.
 */
export function holds(judged: readonly Judged[]): boolean {
  return judged.some((one) => isVerdict(one) && one.judgment.exitCode !== 0)
}

/**
 * What every command of a line would do, in the order the gate reads
 * them, each where it stands, without running any of it (`explainedLine`
 * turns them into the public tree).
 *
 * The dry run of the gate: the same visibility check, the same context,
 * the same policy chain and the same outcome table, so a host reading
 * this and an agent typing the line cannot be told different things.
 * What it deliberately does not do is the half of admission that costs
 * something, since a line nobody typed must not consume a grant or put
 * a question to a host.
 *
 * The words are read literally, as `admitLine` reads them. The prepass asks
 * the profile's rules alone. Both explanation modes ask every policy.
 */
export async function explainLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  reparse: (line: string) => TSNodeLike,
  mode: JudgmentMode = JudgmentMode.EXPLAIN,
): Promise<Judged[]> {
  const judged: Judged[] = []
  for await (const one of judgeLine(
    root,
    session,
    registry,
    namespace,
    reparse,
    rootFrame(root, null),
    mode,
  )) {
    judged.push(one)
  }
  return withCalls(root, judged, null)
}

/**
 * A line's public explanation: its verdict and its parse tree, with every
 * command's explanation where the command stands. A line the profile's
 * rules hold (`holds`, read off `verdicts`, the line judged with `every`
 * false) runs none of it, so its verdict is the first command, in the
 * order the gate reads them, whose refusal holds it, as the run reports
 * it. A runtime that takes the line whole (`wholeLine`) runs none of it
 * once any command is refused (`admitLine`), so there every refusal is
 * the line's, `verdicts` is `judged` itself, whose gate asks every policy,
 * and a line it runs carries the first ask an approval lets through.
 * Otherwise the line runs, and a command refused where it stands (a word a
 * closed tree names nothing for, a policy's own `preCommand` refusal) or a
 * redirect no command owns that its tree refuses (`opened`) fails while
 * the rest goes on. The outcome is then the strictest of every command and
 * every such redirect, deny over ask over allow; the reason, source and
 * decision are the first part's that gives it, in line order; the exit
 * code and stderr are the run's, read off the line's own control flow
 * (`lineStatus`, with `pipefail` the session's option), on the assumption
 * that every command let through succeeds. A line nothing refuses or asks
 * about exits 0 here, since what it returns then is its commands' own
 * business. Every scope a command reads
 * its words in (the typed line, a `$( )` body, a `bash -c` string) is
 * parsed on its own with `reparse`, as the nested line will be; a
 * judgment is placed on the command at its span in that scope, and a
 * nested scope under the command holding it. Mirrors the Python
 * `explained_line`.
 */
export function explainedLine(
  line: string,
  judged: readonly Judged[],
  verdicts: readonly Judged[],
  placedOf: (one: Judged) => string,
  reparse: (line: string) => TSNodeLike,
  wholeLine: boolean,
  opened: readonly Opened[],
  session: SessionState,
): ShellExplanation {
  const scopes: Scope[] = []
  for (const one of judged) {
    const at = one.occurrence
    let scope = scopes.find((s) => s.source === at.source && sameAt(s.parent, at.parent))
    if (scope === undefined) {
      scope = { parent: at.parent, source: at.source, judged: [] }
      scopes.push(scope)
    }
    scope.judged.push(one)
  }
  const root = scopes.find((s) => s.parent === null) ?? { parent: null, source: line, judged: [] }
  const node = scopeNode('line', root, scopes, placedOf, reparse)
  // The run holds a line only on a verdict the pass may give on the gate's
  // behalf (`prejudgeLine`): a question about words the runtime completes
  // (`find -exec`, `xargs`) is the gate's, asked where it runs, so it holds
  // nothing here either.
  const held = verdicts.find(
    (one) => one.judgment.exitCode !== 0 && (wholeLine || (isVerdict(one) && asksFor(one))),
  )
  if (held !== undefined) {
    const judgment = held.judgment
    const [outcome, reason, source] = verdictOf(judgment)
    return {
      line,
      node,
      outcome,
      reason,
      source,
      answers: [],
      decision: judgment.decision,
      exitCode: judgment.exitCode,
      stderr: judgment.stderr,
    }
  }
  if (wholeLine) {
    const asked = verdicts.find(
      (one) => one.judgment.exitCode === 0 && verdictOf(one.judgment)[0] === Outcome.ASK,
    )
    const [outcome, reason, source] =
      asked === undefined ? [Outcome.ALLOW, '', ''] : verdictOf(asked.judgment)
    return {
      line,
      node,
      outcome,
      reason,
      source,
      answers: [],
      decision: null,
      exitCode: 0,
      stderr: '',
    }
  }
  const tree = reparse(line)
  const commands = new Map<string, Judgment[]>()
  const keys: (string | null)[] = []
  for (const one of judged) {
    const at = one.occurrence
    if (at.parent !== null) {
      keys.push(null)
      continue
    }
    const span = `${String(at.start)}:${String(at.end)}`
    const list = commands.get(span) ?? []
    keys.push(`${span}:${String(list.length)}`)
    list.push(one.judgment)
    commands.set(span, list)
  }
  const redirects = new Map<string, Judgment[]>()
  for (const open of opened) {
    const at = open.occurrence
    if (at.parent !== null) continue
    const span = `${String(at.start)}:${String(at.end)}`
    const list = redirects.get(span) ?? []
    list.push(open.judgment)
    redirects.set(span, list)
  }
  const traced = lineStatus(tree, commands, redirects, session)
  const parts = inLineOrder(
    judged.filter((one, i) => !callsFunction(one, keys[i] ?? null, traced)),
    opened,
  )
  let strictest = Outcome.ALLOW
  for (const part of parts) {
    const [said] = verdictOf(part)
    if ((STRICTNESS.get(said) ?? 0) > (STRICTNESS.get(strictest) ?? 0)) strictest = said
  }
  const first =
    strictest === Outcome.ALLOW ? undefined : parts.find((part) => verdictOf(part)[0] === strictest)
  if (first === undefined) {
    return {
      line,
      node,
      outcome: Outcome.ALLOW,
      reason: '',
      source: '',
      answers: [],
      decision: null,
      exitCode: 0,
      stderr: '',
    }
  }
  const [outcome, reason, source] = verdictOf(first)
  return {
    line,
    node,
    outcome,
    reason,
    source,
    answers: [],
    decision: first.decision,
    exitCode: traced.exitCode,
    stderr: traced.ran.map((part) => part.stderr).join(''),
  }
}

/**
 * What a line does as `lineStatus` follows it: its exit code, the
 * refusals it would print in order, the judgments (by span and place among
 * their span's) of the commands that call a function the shell has
 * defined when they run, the judgments the fold reached, run or skipped,
 * for each node the fold enters, by where it starts, the functions defined
 * when it runs, and for each definition the line runs, by where it starts,
 * the functions defined at every command that calls it, which is what its
 * body sees. Mirrors the Python
 * Traced.
 */
interface Traced {
  readonly exitCode: number
  readonly ran: readonly Judgment[]
  readonly calls: ReadonlySet<string>
  readonly reached: ReadonlySet<string>
  readonly at: ReadonlyMap<number, ReadonlySet<string>>
  readonly bodies: ReadonlyMap<number, ReadonlySet<string>>
}

/**
 * The line's judgments with `Judged.defined` set on a word the line has
 * surely made a function call by the time it runs. The rule is kept narrow
 * so it never has to follow the shell: the word heads a simple command of
 * the line itself or of a function body the line defines; the line defines
 * a function of that name before it as one of its top-level statements,
 * not sent to the background, so under no `&&`, `||`, `!`, pipeline,
 * compound command or substitution, where it may not run or may not last;
 * and no word of the line, nor any command it is judged to run, can take a
 * function away or run text in this shell (`FUNCTION_DROPPERS`). Anything
 * else stays a folder's refusal, held with the line. The words of such a
 * call that a wrapper's grammar reads as a command (`timeout 1 rm f`) never
 * run, so they are let through with it. It is worked out only
 * when a folder entry's root refuses some command, the one verdict
 * `defined` changes. Mirrors the Python `_with_calls`.
 */
function withCalls(
  tree: TSNodeLike,
  judged: readonly Judged[],
  origin: Occurrence | null,
): Judged[] {
  const folder = judged.some(
    (one) => one.judgment.exitCode !== 0 && byDefault(one.judgment) && inFolder(one),
  )
  if (!folder) return [...judged]
  const base = tree.startIndex ?? 0
  const defined = new Map<string, number>()
  for (const node of tree.namedChildren) {
    if (node.type !== NodeType.FUNCTION_DEFINITION || isBackgrounded(node)) continue
    const name = getFunctionName(node)
    if (!defined.has(name)) defined.set(name, (node.endIndex ?? 0) - base)
  }
  if (defined.size === 0) return [...judged]
  const nodes = [...walkTree(tree)]
  if (
    judged.some((one) => FUNCTION_DROPPERS.has(one.judgment.command)) ||
    nodes.some(
      (node) =>
        node.type === NodeType.UNSET_COMMAND ||
        (WORD_TYPES.has(node.type) && FUNCTION_DROPPERS.has(literalWord(node) ?? '')),
    )
  ) {
    return [...judged]
  }
  const heads = new Map<string, string | null>()
  const bodies = new Set<number>()
  for (const node of nodes) {
    const start = (node.startIndex ?? 0) - base
    if (node.type === NodeType.FUNCTION_DEFINITION) bodies.add(start)
    if (node.type !== NodeType.COMMAND) continue
    const head = node.namedChildren.find((child) => child.type === NodeType.COMMAND_NAME)
    if (head === undefined) continue
    heads.set(`${String(start)}:${String((node.endIndex ?? 0) - base)}`, literalWord(head))
  }
  const calls = judged.map((one) => callsDefined(one, origin, defined, heads, bodies))
  const callers = judged.filter((_, i) => calls[i] === true).map((one) => one.occurrence)
  return judged.map((one, i) => ({
    ...one,
    defined: calls[i] === true || runsUnder(one.occurrence, callers),
  }))
}

/**
 * Whether a command is spelled by the words of a call to a function
 * (`timeout() { ls; }; timeout 1 rm f`), which runs the function and never
 * the command. Mirrors the Python `_runs_under`.
 */
function runsUnder(at: Occurrence, callers: readonly Occurrence[]): boolean {
  for (let parent = at.parent; parent !== null; parent = parent.parent) {
    if (callers.some((caller) => sameAt(parent, caller))) return true
  }
  return false
}

/**
 * Whether a judgment is about the head word of a simple command that
 * stands, on the line or in a function body the line defines, after the
 * line's top-level definition of a function of that name: `defined` holds
 * where each such definition first ends, `heads` each simple command's head
 * word by its span, `bodies` where each definition starts. Mirrors the
 * Python `_calls_defined`.
 */
function callsDefined(
  one: Judged,
  origin: Occurrence | null,
  defined: ReadonlyMap<string, number>,
  heads: ReadonlyMap<string, string | null>,
  bodies: ReadonlySet<number>,
): boolean {
  const at = one.occurrence
  let offset = 0
  if (!sameAt(at.parent, origin)) {
    const parent = at.parent
    if (parent === null || !sameAt(parent.parent, origin) || !bodies.has(parent.start)) {
      return false
    }
    offset = parent.start
  }
  const name = one.judgment.command
  const end = defined.get(name)
  const start = offset + at.start
  return (
    end !== undefined &&
    end <= start &&
    heads.get(`${String(start)}:${String(offset + at.end)}`) === name
  )
}

/**
 * Whether a judgment is a tree root's own decision about a command that
 * calls a function, which no root's own decision speaks for (`isTool`); a
 * rule that names the function still does. The walk reads the line before
 * any definition runs, so it judges every such call as a tool. A command
 * the fold reached (`key`, its span and place on the typed line) is a call
 * when the function was defined where it stands; one in a function's body
 * when the function was defined at every call of that body; any other, in a
 * substitution or a line a command runs, when the function was defined
 * where that command stands. Mirrors the Python `_calls_function`.
 */
function callsFunction(one: Judged, key: string | null, traced: Traced): boolean {
  if (key !== null && traced.reached.has(key)) return traced.calls.has(key)
  const start = lineStart(one.occurrence)
  const visible = traced.bodies.get(start) ?? traced.at.get(start) ?? new Set<string>()
  return visible.has(one.judgment.command) && byDefault(one.judgment)
}

/**
 * Every command's judgment and every unowned redirect's, in the order the
 * line reaches them: a command where its statement starts on the typed
 * line (one a nested line runs, where the command that runs it does), a
 * redirect where the statement it opens for starts, since the shell opens
 * it before the statement runs. Mirrors the Python `_in_line_order`.
 */
function inLineOrder(judged: readonly Judged[], opened: readonly Opened[]): Judgment[] {
  const placed: [number, Judgment][] = [
    ...judged.map((one): [number, Judgment] => [lineStart(one.occurrence), one.judgment]),
    ...opened.map((open): [number, Judgment] => [lineStart(open.occurrence), open.judgment]),
  ]
  placed.sort((a, b) => a[0] - b[0])
  return placed.map(([, judgment]) => judgment)
}

/**
 * Where on the typed line a part stands: its own start, or for a part a
 * nested line runs, the start of what runs that line. Mirrors the Python
 * `_line_start`.
 */
function lineStart(at: Occurrence): number {
  let top = at
  while (top.parent !== null) top = top.parent
  return top.start
}

/**
 * The exit code a line would return and the refusals it would print on
 * the way, read off the line's control flow with every command let
 * through taken to succeed: a list returns its last statement's status,
 * `&&` and `||` skip what bash skips, a pipeline returns its last stage's
 * (its last failing one under `pipefail`), `!` inverts a command or a whole
 * pipeline, an `if` runs the branch its condition picks, a loop its body
 * once when its condition lets it in, a `case` the arm its word certainly
 * matches (an arm before it whose pattern is a glob leaves it unknown, and
 * none runs), a statement sent to the background (`&`) 0, and a node whose
 * redirect no command owns is refused fails with 1 without running. A
 * function definition, a call to a function and the lines a command runs
 * in turn (`$( )`, `bash -c`, `eval`) answer 0. The fold also follows
 * which functions the shell has defined: a definition counts once it runs,
 * one in a subshell, a pipeline stage or a substitution is gone when that
 * child shell ends, and one on a branch the line skips never counts; a
 * function's body sees the functions defined at every call of it, and a
 * line a command runs in turn the functions defined where that command
 * stands, its own substitutions folded as child shells before it. A tree
 * root's own decision about a command that calls such a function is no
 * refusal.
 * `commands` holds each command's judgments on the typed line, and
 * `redirects` those of the redirects no command owns, by the span of the
 * node they open for. Mirrors the Python `_line_status`.
 */
function lineStatus(
  tree: TSNodeLike,
  commands: ReadonlyMap<string, readonly Judgment[]>,
  redirects: ReadonlyMap<string, readonly Judgment[]>,
  session: SessionState,
): Traced {
  const homes = tildeHomes(session)
  const ran: Judgment[] = []
  const calls = new Set<string>()
  const reached = new Set<string>()
  const defined = new Set<string>()
  const at = new Map<number, ReadonlySet<string>>()
  const starts = new Map<string, number[]>()
  const seen = new Map<string, Set<string>>()
  const spanOf = (node: TSNodeLike): string =>
    `${String(node.startIndex ?? 0)}:${String(node.endIndex ?? 0)}`
  const refused = (judgments: readonly Judgment[], runs: boolean): number => {
    const first = judgments.find((j) => j.exitCode !== 0)
    if (first === undefined || !runs) return 0
    ran.push(first)
    return first.exitCode
  }
  const forked = (run: () => number): number => {
    const kept = new Set(defined)
    const code = run()
    defined.clear()
    for (const name of kept) defined.add(name)
    return code
  }
  const statements = (
    nodes: readonly TSNodeLike[],
    runs: boolean,
    pipeline: PipelineWalk,
  ): number => {
    let code = 0
    for (const node of nodes) {
      if (node.isNamed !== true || INERT.has(node.type)) continue
      if (isBackgrounded(node)) {
        // The owning statement has consumed the `&`; walk the job body once.
        forked(() => status(node, false, { ...pipeline, background: backgroundPipeline(node) }))
        code = 0
      } else {
        code = status(node, runs, pipeline)
      }
    }
    return code
  }
  const command = (span: string, runs: boolean): number => {
    const kept: Judgment[] = []
    for (const [place, judgment] of (commands.get(span) ?? []).entries()) {
      const key = `${span}:${String(place)}`
      reached.add(key)
      if (defined.has(judgment.command) && byDefault(judgment)) {
        calls.add(key)
        const visible = seen.get(judgment.command)
        seen.set(
          judgment.command,
          visible === undefined
            ? new Set(defined)
            : new Set([...visible].filter((name) => defined.has(name))),
        )
      } else {
        kept.push(judgment)
      }
    }
    return refused(kept, runs)
  }
  const status = (node: TSNodeLike, runs: boolean, pipeline: PipelineWalk): number => {
    const kind = nodeKind(node)
    const scope = scopeKind(node, kind)
    const span = spanOf(node)
    const start = node.startIndex ?? 0
    if (!at.has(start)) at.set(start, new Set(defined))
    const code = refused(redirects.get(span) ?? [], runs)
    if (code !== 0) return code
    if (kind === NodeKind.COMMAND || kind === NodeKind.TEST) {
      for (const sub of substitutions(node.children)) status(sub, runs, pipeline)
      const code = command(span, runs)
      if (kind === NodeKind.COMMAND && !pipeline.optionsMayChange) {
        const head = node.namedChildren.find((child) => child.type === NodeType.COMMAND_NAME)
        const name = head === undefined ? null : literalWord(head)
        if (
          name === 'shopt' ||
          name === 'set' ||
          name === 'command' ||
          name === 'builtin' ||
          (name !== null &&
            (pipeline.functions.has(name) || Object.hasOwn(session.functions, name)))
        ) {
          pipeline.optionsMayChange = changesPipelineOptions(
            wordsOf(node, homes),
            session,
            pipeline,
          )
        }
      }
      return code
    }
    if (kind === NodeKind.REDIRECT) {
      for (const sub of substitutions(node.namedChildren.slice(1))) status(sub, runs, pipeline)
      const body = node.namedChildren[0]
      if (body === undefined || REDIRECT_TYPES.has(body.type)) return 0
      return status(body, runs, pipeline)
    }
    if (kind === NodeKind.LIST) {
      const left = node.children[0]
      const op = node.children[1]
      const right = node.children[node.children.length - 1]
      if (left === undefined || op === undefined || right === undefined) return 0
      const code = status(left, runs, pipeline)
      const goes = connectionRunsRight(op.type, code)
      const later = status(right, runs && goes, pipeline)
      return goes ? later : code
    }
    if (scope === ScopeKind.PIPELINE) {
      const stages = [...node.namedChildren]
      const first = stages[0]
      const negated = first?.type === NodeType.NEGATED_COMMAND
      if (negated) {
        const inner = first.namedChildren[first.namedChildren.length - 1]
        if (inner !== undefined) stages[0] = inner
      }
      const codes = stages.map((stage, index) =>
        !stageForks(index === stages.length - 1, session, pipeline)
          ? status(stage, runs, pipeline)
          : forked(() => status(stage, runs, { ...pipeline, background: false })),
      )
      const last =
        session.shellOptions.pipefail === true
          ? ([...codes].reverse().find((c) => c !== 0) ?? 0)
          : (codes[codes.length - 1] ?? 0)
      return negated ? (last !== 0 ? 0 : 1) : last
    }
    if (kind === NodeKind.NEGATED) return statements(node.children, runs, pipeline) !== 0 ? 0 : 1
    if (scope === ScopeKind.FORK || scope === ScopeKind.SUBSTITUTION)
      return forked(() => statements(node.children, runs, { ...pipeline, background: false }))
    if (kind === NodeKind.IF) {
      const [branches, elseBody] = getIfBranches(node)
      let code = 0
      let taken = false
      for (const [head, body] of branches) {
        const live = runs && !taken
        const hit = statements(head, live, pipeline) === 0 && live
        const result = statements(body, hit, pipeline)
        if (hit) {
          code = result
          taken = true
        }
      }
      if (elseBody !== null) {
        const live = runs && !taken
        const result = statements(elseBody, live, pipeline)
        if (live) code = result
      }
      return code
    }
    if (scope === ScopeKind.REPEATED && (kind === NodeKind.WHILE || kind === NodeKind.UNTIL)) {
      const loop = node.namedChildren.filter((c) => c.type === NodeType.DO_GROUP)
      const head = node.children.filter((c) => c.type !== NodeType.DO_GROUP)
      const until = kind === NodeKind.UNTIL
      const entered = runs && (statements(head, runs, pipeline) === 0) !== until
      const code = statements(loop, entered, pipeline)
      return entered ? code : 0
    }
    if (scope === ScopeKind.DEFERRED) {
      const name = getFunctionName(node)
      pipeline.functions = new Set([...pipeline.functions, name])
      if (runs) {
        defined.add(name)
        starts.set(name, [...(starts.get(name) ?? []), node.startIndex ?? 0])
      }
      return 0
    }
    if (kind === NodeKind.CASE) {
      const arm = caseArm(node)
      let code = 0
      for (const [index, [, body]] of getCaseItems(node).entries()) {
        const hit = runs && index === arm
        const result = statements(body, hit, pipeline)
        if (hit) code = result
      }
      return code
    }
    if (scope === ScopeKind.REPEATED) {
      return statements(
        node.namedChildren.filter((c) => c.type === NodeType.DO_GROUP),
        runs,
        pipeline,
      )
    }
    return statements(node.children, runs, pipeline)
  }
  const exitCode = status(tree, true, pipelineWalk())
  const bodies = new Map<number, ReadonlySet<string>>()
  for (const [name, places] of starts) {
    for (const start of places) bodies.set(start, seen.get(name) ?? new Set<string>())
  }
  return { exitCode, ran, calls, reached, at, bodies }
}

/**
 * The outermost substitutions (`$( )`, `<( )`) among a command's words or a
 * statement's redirects, which run, each in a child shell, before the
 * command does. Mirrors the Python `_substitutions`.
 */
function substitutions(nodes: readonly TSNodeLike[]): TSNodeLike[] {
  const found: TSNodeLike[] = []
  for (const node of nodes) {
    if (scopeKind(node) === ScopeKind.SUBSTITUTION) {
      found.push(node)
    } else {
      found.push(...substitutions(node.children))
    }
  }
  return found
}

/**
 * The arm of a `case` its word certainly matches: the first whose pattern
 * is the word itself or a bare `*`, when the word is literal and no arm
 * before it holds a pattern only the shell's matcher can decide (a glob, a
 * quote, an expansion). Null when no arm is certain. Mirrors the Python
 * `_case_arm`.
 */
function caseArm(node: TSNodeLike): number | null {
  const word = literalWord(getCaseWord(node))
  if (word === null) return null
  for (const [index, [patterns]] of getCaseItems(node).entries()) {
    for (const pattern of patterns) {
      const text = getText(pattern)
      if (text === '*' || text === word) return index
      if (/[*?[\]\\'"$`]/.test(text)) return null
    }
  }
  return null
}

/**
 * Every redirect of a line no command owns that the session's trees refuse
 * or ask about, judged where its statement stands, a `cd` before it on the
 * line included, as `admitRedirect` judges it when the shell opens it,
 * without asking anyone: an ask reads the session's standing grants and
 * stops there (`Decisions.held`), as a command's does. A target only the
 * runtime can expand (`> $f`), or a relative one after a `cd` the walk
 * could not follow, is left to the run. Mirrors the Python
 * `explain_redirects`.
 */
export async function explainRedirects(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  reparse: (line: string) => TSNodeLike,
): Promise<Opened[]> {
  const out: Opened[] = []
  for (const item of walkedLine(root, session, reparse, null, false, true)) {
    if (item.words.length > 0) continue
    const at = item.occurrence
    const row = at.source.slice(0, at.start).split('\n').length
    const voice = `${voiceName(item.session)}: line ${String(row)}: `
    for (const word of item.redirects) {
      if (item.lost === true && !wordValue(word).startsWith('/')) continue
      const targets = redirectPaths([word], registry, item.session.cwd)
      const asked = redirectAsked(targets, item.session, namespace)
      if (asked === null) continue
      const answer = asked.answer
      const action =
        answer.kind === 'ask' ? await registry.decisions.held(asked.question, answer) : answer
      const rule = answer.rule ?? null
      let judgment: Judgment = {
        command: '',
        argv: asked.question.argv,
        outcome: answer.kind === 'ask' ? Outcome.ASK : Outcome.DENY,
        rule,
        reason: answer.reason,
        source: rule === null ? '' : sourceOf(rule),
        matchedPath: asked.named,
        paths: asked.question.argv,
        exitCode: 0,
        stderr: '',
        decision: null,
        answers: [answer],
        words: [],
      }
      if (action !== null) {
        const refusal = redirectRefused(targets, asked.named, action, voice)
        judgment = {
          ...judgment,
          exitCode: refusal.exitCode,
          stderr: decodeText(refusal.stderr),
          decision: refusal.decision,
        }
      }
      out.push({ judgment, occurrence: at })
    }
  }
  return out
}

/** One scope of a line: the occurrence its text was evaluated from, the text, and its judgments. */
interface Scope {
  readonly parent: Occurrence | null
  readonly source: string
  readonly judged: Judged[]
}

/** Whether two occurrences name the same place, as Python's dataclass equality reads them. */
function sameAt(a: Occurrence | null, b: Occurrence | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.source === b.source && a.start === b.start && a.end === b.end && sameAt(a.parent, b.parent)
  )
}

/**
 * What a command's answers come to as the gate reads them: the first Deny
 * (two routes that disagree among them), else the first Ask; a route the
 * answers agree on refuses nothing. Mirrors the Python `_refusal`.
 */
function refusal(answers: readonly (Deny | Ask | Route)[]): Deny | Ask | null {
  const verdict = settled(answers)
  return verdict?.kind === 'route' ? null : verdict
}

/**
 * A command's outcome, reason and source as its explanation states them:
 * the refusal it meets (`ASK` for a question waiting on the host, `DENY`
 * for any other, a policy that failed included), else the ask an approval
 * lets through, else `DENY` for a command no tree names. The reason
 * and source are the deciding answer's, which a coded policy may give over
 * the document's own. Mirrors the Python `_verdict_of`.
 */
function verdictOf(judgment: Judgment): [Outcome, string, string] {
  const decider = refusal(judgment.answers)
  const source =
    decider?.rule !== undefined
      ? sourceOf(decider.rule)
      : judgment.source === 'commands'
        ? judgment.source
        : ''
  const refused = judgment.decision
  if (refused !== null) {
    return [isPending(refused) ? Outcome.ASK : Outcome.DENY, refused.reason, source]
  }
  if (decider?.kind === 'ask') return [Outcome.ASK, decider.reason, source]
  if (judgment.exitCode !== 0) return [Outcome.DENY, '', source]
  return [Outcome.ALLOW, '', source]
}

/**
 * One scope of a line as a node: its text parsed, the commands judged in
 * it placed by span, and the scopes evaluated from it placed under the
 * command holding them. Mirrors the Python `_scope_node`.
 */
function scopeNode(
  kind: string,
  scope: Scope,
  scopes: readonly Scope[],
  placedOf: (one: Judged) => string,
  reparse: (line: string) => TSNodeLike,
): ShellNode {
  const text = scope.source
  const mine = new Map<string, Judged[]>()
  for (const one of scope.judged) {
    const span = `${String(one.occurrence.start)}:${String(one.occurrence.end)}`
    mine.set(span, [...(mine.get(span) ?? []), one])
  }
  const nested = scopes
    .filter(
      (s): s is Scope & { parent: Occurrence } =>
        s.parent !== null && s.parent.source === text && sameAt(s.parent.parent, scope.parent),
    )
    .sort((a, b) => a.parent.start - b.parent.start || a.parent.end - b.parent.end)
  const take = (start: number, end: number): ShellNode[] => {
    const inside = nested.filter((s) => start <= s.parent.start && s.parent.end <= end)
    for (const s of inside) nested.splice(nested.indexOf(s), 1)
    return inside.map((s) =>
      scopeNode(
        s.parent.start === start && s.parent.end === end ? 'line' : 'substitution',
        s,
        scopes,
        placedOf,
        reparse,
      ),
    )
  }
  const convert = (node: TSNodeLike): (ShellNode | CommandExplanation)[] => {
    const start = node.startIndex ?? 0
    const end = node.endIndex ?? 0
    if (node.type === NodeType.COMMAND || node.type === NodeType.TEST_COMMAND) {
      const kids = take(start, end)
      const span = `${String(start)}:${String(end)}`
      const ones = mine.get(span) ?? []
      mine.delete(span)
      if (ones.length === 0) return [{ type: 'command', text: getText(node), children: kids }]
      return ones.map((one, i) => commandOf(one, getText(node), i === 0 ? kids : [], placedOf))
    }
    if (scopeKind(node) === ScopeKind.SUBSTITUTION) return take(start, end)
    const inner = node.namedChildren.flatMap(convert)
    const shape = SHAPES.get(node.type)
    return shape === undefined ? inner : [{ type: shape, text: getText(node), children: inner }]
  }
  const children = convert(reparse(text))
  for (const [span, ones] of mine) {
    const [start, end] = span.split(':').map(Number)
    const spoken = text.slice(start, end)
    for (const item of ones.map((one) => commandOf(one, spoken, [], placedOf))) children.push(item)
  }
  for (const item of take(0, Number.MAX_SAFE_INTEGER)) children.push(item)
  return { type: kind, text, children }
}

/** One command's public explanation. Mirrors the Python `_command_of`. */
function commandOf(
  one: Judged,
  text: string,
  children: readonly ShellNode[],
  placedOf: (one: Judged) => string,
): CommandExplanation {
  const judgment = one.judgment
  const [outcome, reason, source] = verdictOf(judgment)
  const machine = placedOf(one)
  return {
    type: 'command',
    command: judgment.command,
    words: judgment.words,
    exitCode: judgment.exitCode,
    stderr: judgment.stderr,
    outcome,
    reason,
    source,
    answers: judgment.answers,
    decision: judgment.decision,
    machine,
    text,
    children,
  }
}

/**
 * Every command of a line judged, in the order the gate reads them, each
 * with its place on the line, one at a time as `judgeWords` yields them.
 * Nested lines can start with an unknown cwd, or with words or operands
 * the runtime will complete where they run.
 */
async function* judgeLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  reparse: (line: string) => TSNodeLike,
  frame: Frame,
  mode: JudgmentMode,
  {
    stated = true,
    lost = false,
    open = false,
    pipeline = pipelineWalk(takesWholeLine(mode)),
  }: {
    stated?: boolean
    lost?: boolean
    open?: boolean
    pipeline?: PipelineWalk | undefined
  } = {},
): AsyncGenerator<Judged> {
  const judged = (item: Walked, place: SessionState): AsyncGenerator<Judged> =>
    judgeWords(
      { ...item, session: place, stated: stated && item.stated !== false, open },
      mode,
      registry,
      namespace,
      reparse,
    )
  // What the machine's shell runs on its own: a hook set on the line, or one
  // the session's environment hands it.
  const hooked = takesWholeLine(mode) ? written(root, HOOK_VARS) : null
  const carried = takesWholeLine(mode)
    ? (Object.keys(envSnapshot(session)).find(isHook) ?? null)
    : null
  if (
    (hooked !== null || carried !== null) &&
    (hasRules(session.commands) ||
      (await registry.policies.wantsFor('preCommand', session.sessionId, true)))
  ) {
    const [node, name] = hooked ?? [root, carried ?? '']
    yield {
      judgment: denied(name, UNREADABLE_LINES),
      occurrence: occurrenceIn(node, frame),
      stated: false,
    }
    return
  }
  let homes = tildeHomes(session)
  if (
    takesWholeLine(mode) &&
    (written(root, HOME_VAR) !== null ||
      written(typedLine(root, frame, reparse), HOME_VAR) !== null)
  ) {
    // The machine's shell expands a later `~` with the HOME it was set.
    homes = Object.fromEntries(Object.entries(homes).filter(([name]) => name !== ''))
  }
  for (const item of walkedLine(root, session, reparse, frame, lost, false, pipeline, homes)) {
    const elsewhere = item.elsewhere ?? []
    if (!takesWholeLine(mode) || elsewhere.length === 0) {
      yield* judged(item, item.session)
      continue
    }
    const places: Judged[][] = []
    for (const place of [item.session, ...elsewhere]) {
      const one: Judged[] = []
      for await (const judgment of judged(item, place)) one.push(judgment)
      places.push(one)
    }
    yield* strictest(places)
  }
}

/**
 * The parse of the line a frame's text was typed in: `root` itself for a typed
 * line, else the outermost line it was evaluated from.
 */
function typedLine(
  root: TSNodeLike,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
): TSNodeLike {
  let at = frame.parent
  if (at === null) return root
  while (at.parent !== null) at = at.parent
  return reparse(at.source)
}

/**
 * A word as a whole line's gate reads it: a leading `~` the gate left
 * unexpanded (a user it does not know, `~+`, or `~` once the line set HOME)
 * names what only the machine's shell can say.
 */
function machineWord(word: Word): Word {
  if (word.text === null) return word
  if ((word.raw.startsWith('~') && word.text.startsWith('~')) || ASSIGNED_TILDE.test(word.raw)) {
    return { ...word, text: null }
  }
  return word
}

/**
 * The first node anywhere on a line (a function body or a substitution's
 * included) that sets one of `names`, with the name: an assignment, a loop
 * variable, a `declare -n` aimed at one, or a builtin storing into one (`read`,
 * `mapfile`, `readarray`, `getopts`, `printf -v`); null when there is none.
 */
function written(
  root: TSNodeLike,
  names: ReadonlySet<string>,
): readonly [TSNodeLike, string] | null {
  const stack: TSNodeLike[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    const name = sets(node, names)
    if (name !== null) return [node, name]
    // A declaration read its assignments' names; only their values are left
    // to walk.
    const kids =
      node.type === NodeType.DECLARATION_COMMAND
        ? node.children.flatMap((kid) =>
            kid.type === NodeType.VARIABLE_ASSIGNMENT ? [...kid.children] : [kid],
          )
        : [...node.children]
    stack.push(...kids.reverse())
  }
  return null
}

/**
 * The one of `names` a declaration builtin's words set, as `sets` answers;
 * none when `declare`, `typeset` or `local` only prints (`-p`, `-f`, `-F`).
 */
function declared(head: string, words: readonly Word[], names: ReadonlySet<string>): string | null {
  if (NAMEREFS.has(head)) {
    for (const word of words) {
      if (word.text === null || !word.text.startsWith('-') || word.text === '--') break
      if (/[pfF]/.test(word.text)) return null
    }
  }
  for (const word of words) {
    if (word.text === null) return head
    if (NAMEREFS.has(head) && word.text.startsWith('-') && word.text.includes('n')) return head
    const name = word.text.split('=', 1)[0]?.split('[', 1)[0] ?? ''
    if (names.has(name)) return name
  }
  return null
}

/**
 * The one of `names` a node sets itself (an element of it included), null
 * when it sets none. A node setting a variable the gate cannot name (a
 * `declare -n` nameref, a store into a word only the run expands) answers with
 * its command's name.
 */
function sets(node: TSNodeLike, names: ReadonlySet<string>): string | null {
  const kids = node.children
  if (node.type === NodeType.EXPANSION && !kids.some((k) => k.type === ':=' || k.type === '=')) {
    return null
  }
  if (
    node.type === NodeType.VARIABLE_ASSIGNMENT ||
    node.type === NodeType.FOR_STATEMENT ||
    node.type === NodeType.EXPANSION
  ) {
    for (let kid of kids.slice(0, 3)) {
      if (kid.type === NodeType.SUBSCRIPT && kid.children[0] !== undefined) kid = kid.children[0]
      if (kid.type === NodeType.VARIABLE_NAME && names.has(getText(kid))) return getText(kid)
    }
    return null
  }
  if (node.type === NodeType.DECLARATION_COMMAND) {
    const head = kids[0] === undefined ? '' : getText(kids[0])
    // An assignment is read by its name, the value aside; any other word is
    // a flag or a NAME[=VALUE] the builtin parses at run time.
    const words = kids.slice(1).map((k): Word => {
      if (k.type === NodeType.VARIABLE_ASSIGNMENT) {
        const name = `${k.children[0] === undefined ? '' : getText(k.children[0])}=`
        return { raw: name, text: name }
      }
      if (k.type === NodeType.VARIABLE_NAME) return { raw: getText(k), text: getText(k) }
      return readWord(k, null)
    })
    return declared(head, words, names)
  }
  if (node.type !== NodeType.COMMAND) return null
  let words = wordsOf(node, null)
  while (words[0] !== undefined && ['command', 'builtin'].includes(wordValue(words[0]))) {
    words = words.slice(1)
    while (words[0] !== undefined) {
      const option = wordValue(words[0])
      if (!option.startsWith('-') || option === '-') break
      words = words.slice(1)
      if (option === '--') break
      // `command -v`/`-V` only looks names up.
      if (option.includes('v') || option.includes('V')) return null
    }
  }
  if (words[0] === undefined) return null
  const head = wordValue(words[0])
  if (DECLARES.has(head)) return declared(head, words.slice(1), names)
  let targets: Word[]
  if (head === 'printf') {
    targets = printfTarget(words.slice(1))
  } else if (STORES.has(head)) {
    targets = stored(head, words.slice(1))
  } else {
    return null
  }
  for (const word of targets) {
    if (word.text === null) return head
    const name = word.text.split('[', 1)[0] ?? ''
    if (names.has(name)) return name
  }
  return null
}

/**
 * The variable `printf -v` stores into, read off its options before the
 * format; none when it prints.
 */
function printfTarget(args: readonly Word[]): Word[] {
  for (let at = 0; at < args.length; at++) {
    const word = args[at]
    if (word === undefined) break
    // The run may expand an unknown word to an option, `-v NAME` among them.
    if (word.text === null) return [word]
    const value = wordValue(word)
    if (!value.startsWith('-') || value === '-' || value === '--') return []
    if (value === '-v') return args.slice(at + 1, at + 2)
    if (value.startsWith('-v')) {
      const rest = value.slice(2)
      return [{ raw: rest, text: rest }]
    }
  }
  return []
}

/**
 * The words a storing builtin stores into: `read`'s operands and its `-a`
 * array, `mapfile`'s array, `getopts`'s name after its optstring; an option's
 * value is no target.
 */
function stored(head: string, args: readonly Word[]): Word[] {
  const valued = STORES.get(head) ?? ''
  const targets: Word[] = []
  let i = 0
  while (i < args.length) {
    const word = args[i]
    if (word === undefined) break
    const value = wordValue(word)
    if (!value.startsWith('-') || value === '-') break
    i += 1
    // The run may expand it to options that store into anything.
    if (word.text === null) return [word]
    if (value === '--') break
    for (let at = 1; at < value.length; at++) {
      if (!valued.includes(value[at] ?? '')) continue
      const rest = value.slice(at + 1)
      let given: Word | null = null
      if (rest !== '') {
        given = { raw: rest, text: rest }
      } else {
        given = args[i] ?? null
        i += 1
      }
      if (value[at] === 'a' && given !== null) targets.push(given)
      break
    }
  }
  let operands = args.slice(i)
  if (head === 'getopts') operands = operands.slice(1, 2)
  else if (head !== 'read') operands = operands.slice(0, 1)
  return [...targets, ...operands]
}

/**
 * What a command is judged to do where it may stand, the strictest first: a
 * place where it is refused, then one where it asks, then where the walk
 * predicts it stands.
 */
function strictest(places: readonly Judged[][]): Judged[] {
  const first = places.map((judged) => judged.find((one) => one.judgment.exitCode !== 0))
  for (const refused of [true, false]) {
    const index = first.findIndex((one) => one !== undefined && refuses(one.judgment) === refused)
    if (index >= 0) return places[index] ?? []
  }
  return places[0] ?? []
}

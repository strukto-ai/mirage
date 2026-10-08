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

import { refusalOf, renderDeny, renderPending } from '../../policy/index.ts'
import { decide, sourceOf } from '../../policy/match/decide.ts'
import { hasRules } from '../../policy/match/reads.ts'
import {
  Outcome,
  type Ask,
  type Claimant,
  type CommandContext,
  type CommandExplanation,
  type CommandRule,
  type Deny,
  type HandOff,
  type Occurrence,
  type Pending,
  type ShellExplanation,
  type ShellNode,
  type ShellOperand,
} from '../../policy/types.ts'
import {
  inputSubstitutionRedirect,
  getParts,
  getText,
  literalWord,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import { opaqueReads, referencedNames } from '../../shell/parse/index.ts'
import { NodeType, type TSNodeLike } from '../../shell/types.ts'
import { PathSpec, type Refusal } from '../../types.ts'
import { resolvePath } from '../../utils/path.ts'
import { makeAbortError } from '../abort.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { SessionState } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import {
  Admitted,
  admit,
  classifiedWords,
  gate,
  isPendingRefusal,
  redirectPaths,
  statementRedirects,
  type Refused,
  UNREADABLE_LINES,
  unreadable,
} from './admission.ts'
import { innerLines, innerReadable, readWord, wordValue, type Word } from './inner_lines.ts'
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
import { decodeText } from '../../shell/bytes.ts'

/**
 * Nodes that run their commands in a child shell: a `cd` inside one
 * applies to the rest of that child and is gone when it exits. A
 * pipeline is not here because it forks per segment, not once.
 */
const FORK_SCOPES: ReadonlySet<string> = new Set([
  NodeType.SUBSHELL,
  NodeType.COMMAND_SUBSTITUTION,
  NodeType.PROCESS_SUBSTITUTION,
])

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

/** The nodes whose body a nested line evaluates on its own. Mirrors the Python SUBSTITUTIONS. */
const SUBSTITUTIONS: ReadonlySet<string> = new Set([
  NodeType.COMMAND_SUBSTITUTION,
  NodeType.PROCESS_SUBSTITUTION,
])

/**
 * What the gate decides about one command of a line, as the pass reads
 * it: the per-command record `explain` and the admission pass share,
 * which `explainedLine` turns into the public tree. `outcome` is the
 * document's answer and `rule` says who gave it; the two refusals the
 * allow list produces both arrive as `DENY` with no rule, and `exitCode`
 * separates them (127 for a head word the session cannot see, 126 for a
 * visible head no allow entry covers). Mirrors the Python Judgment.
 */
export interface Judgment {
  /** The head word, as the gate read it. */
  readonly command: string
  /** The words after it. */
  readonly argv: readonly string[]
  /** What the profile's rules say. */
  readonly outcome: Outcome
  /** The rule that spoke, null when the allow list did or nothing did. */
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
  readonly refusal: Refusal | null
  /** Every policy's answer to the command, in the order the chain asks them. */
  readonly answers: readonly (Deny | Ask)[]
  /** Its path arguments and redirect targets, as typed and as the paths they name. */
  readonly operands: readonly ShellOperand[]
}

/**
 * One command of a walked line, as both readers of the line see it: its
 * words, the redirect targets of its statement, the session it is
 * judged in, and where it stands. Mirrors the Python Walked. `lost`
 * says a `cd` the walk could not follow ran before the command, so the
 * session's cwd is not where it stands.
 */
export interface Walked {
  readonly words: Word[]
  readonly redirects: Word[]
  readonly session: SessionState
  readonly occurrence: Occurrence
  readonly intrinsic?: boolean
  readonly lost?: boolean
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
}

/**
 * A walk yields each command and returns where its scope ends: the
 * session, and whether a `cd` it could not follow lost the cwd. That is
 * how a `cd` reaches the commands after it without escaping the child
 * shell it ran in.
 */
type Walk = Generator<Walked, [SessionState, boolean]>

/**
 * A judgment with its path operands, each as typed and the path it
 * names, marked when the rule that decided matched it. Mirrors the
 * Python `_with_operands`.
 */
function withOperands(judgment: Judgment, operands: readonly [string, string][]): Judgment {
  return {
    ...judgment,
    operands: operands.map(([text, path]) => ({
      text,
      path,
      matched: text === judgment.matchedPath,
    })),
  }
}

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
  const deny: Deny = { kind: 'deny', reason, scope: 'command' }
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
    refusal: refusalOf(deny),
    answers: [],
    operands: [],
  }
}

/**
 * The explanation of a head word the session cannot see. `missing` is
 * how the command running the word reports it (`InnerLine.missing`),
 * null for the gate's own words.
 */
function fromRefusal(
  name: string,
  args: readonly string[],
  refusal: Refused,
  missing: string | null = null,
): Judgment {
  return {
    command: name,
    argv: args,
    outcome: Outcome.DENY,
    rule: null,
    reason: '',
    source: 'commands.allow',
    matchedPath: null,
    paths: [],
    exitCode: refusal.exitCode,
    stderr: missing ?? decodeText(refusal.stderr),
    refusal: refusal.refusal,
    answers: [],
    operands: [],
  }
}

/**
 * One command's explanation, rendered from the same table the gate
 * renders a refusal with.
 *
 * An Ask reads the session's standing grants and stops there
 * (`Decisions.held`): a dry run must not spend one, record a question
 * or reach the host. An answer that already covers the ask leaves the
 * outcome ASK, because that is what the document says, with exit 0,
 * because that is what the line would do.
 */
async function explained(
  ctx: CommandContext,
  session: SessionState,
  registry: MountRegistry,
  asked: Deny | Ask | null,
  answers: readonly (Deny | Ask)[],
): Promise<Judgment> {
  const decision = decide(ctx, session.commands)
  const base: Judgment = {
    command: ctx.command,
    argv: ctx.argv,
    outcome: decision.outcome,
    rule: decision.rule,
    reason: decision.rule?.reason ?? '',
    source: decision.source,
    matchedPath: decision.matchedPath,
    paths: ctx.paths.map((p) => p.virtual),
    exitCode: 0,
    stderr: '',
    refusal: null,
    answers,
    operands: [],
  }
  const action: Deny | Pending | null =
    asked !== null && asked.kind === 'ask' ? await registry.decisions.held(ctx, asked) : asked
  if (action === null) return base
  const [stderr, exitCode] =
    action.kind === 'pending' ? renderPending(ctx.command, action) : renderDeny(ctx.command, action)
  return {
    ...base,
    reason: base.reason === '' ? action.reason : base.reason,
    exitCode,
    stderr: decodeText(stderr),
    refusal: refusalOf(action),
  }
}

/**
 * Explain one command and whatever lines it runs in turn, each with its
 * occurrence. The redirect targets are read as words of the command,
 * exactly as admission reads them: the shell opens them on its own fds,
 * outside the window the command's own gate covers, so a rule about
 * `/protected` sees `echo x > /protected` only if they are passed here;
 * they are empty for a command with none and for the inner lines a
 * command runs, which admission reads the same way. A line the command runs (`eval`, `sh -c`) is parsed on
 * its own and read under the command's occurrence, exactly as the
 * nested evaluation will stand when it runs. `stated` is whether the
 * words reach here as the gate will read them; false under a command
 * the runtime completes, since a line built from its words (`eval`) or
 * run on its operands (`xargs`) is completed with them. `missing` is
 * how the command that runs these words reports a name the session
 * cannot see, null for the gate's own words: `xargs` and `timeout` look
 * the name up before the gate reads it, so the run prints theirs.
 * `wholeLine` is whether a runtime takes the line whole: only its gate
 * refuses a name the runtime expands, and only under a rule (`admitLine`);
 * the executor judges the expanded name. `lost` is whether a `cd` the
 * walk could not follow ran before the command, as `Walked` carries it.
 * `every` asks every policy past a Deny, for `explain`.
 */
async function judgeWords(
  words: readonly Word[],
  occurrence: Occurrence,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  redirectWords: readonly Word[] = [],
  stated = true,
  missing: string | null = null,
  intrinsic = false,
  wholeLine = false,
  lost = false,
  every = false,
): Promise<Judged[]> {
  const head = words[0]
  if (head === undefined) return []
  if (head.text === null) {
    if (wholeLine && hasRules(session.commands)) {
      return [{ judgment: denied(head.raw, unreadable(head.raw)), occurrence, stated: false }]
    }
    return []
  }
  const literal = stated && [...words, ...redirectWords].every((w) => w.text !== null)
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const classified = classifiedWords(name, args, session, registry)
  const readWords = [...words.slice(1), ...redirectWords]
  const kinds = [
    ...classified.slice(1),
    ...redirectWords.map((w) => classifyBarePath(wordValue(w), registry, session.cwd)),
  ]
  const unread = unreadPaths(readWords, kinds, session.cwd, lost)
  const operands: [string, string][] = []
  readWords.forEach((w, i) => {
    const kind = kinds[i]
    if (kind instanceof PathSpec) operands.push([kind.rawPath || wordValue(w), kind.virtual])
  })
  const gated = await gate(
    name,
    args,
    classified.slice(1),
    session,
    registry,
    namespace,
    agentId,
    null,
    redirectPaths(redirectWords, registry, session.cwd),
    intrinsic,
    unread,
    every,
  )
  if (!Array.isArray(gated)) {
    return [
      {
        judgment: withOperands(fromRefusal(name, args, gated, missing), operands),
        occurrence,
        stated: literal,
        intrinsic,
      },
    ]
  }
  const [ctx, asked, answers] = gated
  const out: Judged[] = [
    {
      judgment: withOperands(await explained(ctx, session, registry, asked, answers), operands),
      occurrence,
      stated: literal,
      intrinsic,
      unread,
      ctx,
    },
  ]
  for (const inner of innerLines(name, words.slice(1))) {
    if (!innerReadable(inner)) {
      if (wholeLine && hasRules(session.commands)) {
        return [
          {
            judgment: withOperands(denied(name, UNREADABLE_LINES), operands),
            occurrence,
            stated: literal,
            intrinsic,
          },
        ]
      }
      continue
    }
    if (inner.line !== null) {
      out.push(
        ...(await judgeLine(
          reparse(inner.line),
          session,
          registry,
          namespace,
          agentId,
          reparse,
          lineFrame(inner.line, occurrence),
          literal && !inner.open,
          wholeLine,
          lost,
          every,
        )),
      )
    } else {
      const within = wholeOccurrence(argvFrame(inner.argv.map(wordValue), occurrence))
      out.push(
        ...(await judgeWords(
          inner.argv,
          within,
          session,
          registry,
          namespace,
          agentId,
          reparse,
          [],
          literal && !inner.open,
          inner.missing,
          false,
          wholeLine,
          lost,
          every,
        )),
      )
    }
  }
  return out
}

/** One command node's words, name first, the env prefix dropped. */
function wordsOf(node: TSNodeLike, home: string | null): Word[] {
  const [, parts] = splitEnvPrefix(getParts(node))
  return parts.map((part) => readWord(part, home))
}

/**
 * Every command under one node, in source order, each with the session
 * it is judged in; returns the session the node leaves behind.
 *
 * A `cd` reaches the commands after it, and how far is the whole
 * question. Pinned against bash: `( )`, `$( )` and `<( )` run their
 * contents in a child shell, so a `cd` inside one applies to the rest of
 * that child and is gone when it exits; a pipeline forks once per
 * segment, so a `cd` in one segment reaches neither the next segment nor
 * the line; `&` backgrounds into a fork; and a brace group or an `if`
 * body does not fork at all, so its `cd` does escape. Reading a subshell
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
  home: string | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  lost: boolean,
): Walk {
  const redirect = inputSubstitutionRedirect(tree)
  if (redirect === null) return yield* walkNode(tree, session, home, frame, reparse, lost)
  const target = redirect.targetNode as TSNodeLike
  yield {
    words: [{ raw: 'cat', text: 'cat' }],
    redirects: [{ raw: getText(target), text: literalWord(target, home) }],
    session,
    occurrence: occurrenceIn(tree, frame),
    intrinsic: true,
    lost,
  }
  yield* walkNode(target, session, home, frame, reparse, lost)
  return [session, lost]
}

function* walkNode(
  node: TSNodeLike,
  session: SessionState,
  home: string | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  lost = false,
): Walk {
  if (node.type === NodeType.FUNCTION_DEFINITION) frame = definitionFrame(node, frame)
  if (node.type === NodeType.COMMAND) {
    let walked: [SessionState, boolean] = [session, lost]
    const words = wordsOf(node, home)
    if (words.length > 0) {
      yield {
        words,
        redirects: statementRedirects(node, home),
        session,
        occurrence: occurrenceIn(node, frame),
        lost,
      }
      walked = afterCd(words, session, lost)
    }
    // A substitution among the words runs in its own shell.
    for (const child of node.children) yield* walkNode(child, session, home, frame, reparse, lost)
    return walked
  }
  if (FORK_SCOPES.has(node.type)) {
    // A substitution's body is walked in a frame of its own: the nested
    // line that evaluates it parses the body alone, under the
    // substitution's node, and the commands in it have to be placed
    // here exactly where that line will place them.
    const segments = segmentFrames(node, frame)
    if (segments.length > 0) {
      // A backtick region is read as the evaluator runs it: one line per
      // pair, parsed on its own, because tree-sitter lexes touching pairs
      // as one node whose subtree is not what runs.
      for (const inner of segments) {
        yield* walkSubstitution(reparse(inner.text), session, home, inner, reparse, lost)
      }
      return [session, lost]
    }
    const inner = bodyFrame(node, frame)
    if (node.type === NodeType.COMMAND_SUBSTITUTION && inner !== null) {
      const body = { ...inner, base: 0 }
      yield* walkSubstitution(reparse(inner.text), session, home, body, reparse, lost)
      return [session, lost]
    }
    yield* walkChildren(node, session, home, inner ?? frame, reparse, lost)
    return [session, lost]
  }
  if (node.type === NodeType.PIPELINE) {
    for (const child of node.children) yield* walkNode(child, session, home, frame, reparse, lost)
    return [session, lost]
  }
  return yield* walkChildren(node, session, home, frame, reparse, lost)
}

/**
 * One scope's children in order, threading the cwd between them; returns
 * where the scope ends.
 */
function* walkChildren(
  node: TSNodeLike,
  session: SessionState,
  home: string | null,
  frame: Frame,
  reparse: (line: string) => TSNodeLike,
  lost: boolean,
): Walk {
  let walked: [SessionState, boolean] = [session, lost]
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child === undefined) continue
    const ended = yield* walkNode(child, walked[0], home, frame, reparse, walked[1])
    if (children[index + 1]?.type === '&') continue
    walked = ended
  }
  return walked
}

/**
 * Where the next command of a line stands, which differs from this one
 * only when this command was a `cd`.
 *
 * `cd /repo && git commit` is judged before the line runs, so without
 * this the rule about `/repo` reads the cwd the session happened to be
 * in and answers about the wrong directory. A `cd` the walk cannot
 * follow (`cd "$d"`, `cd -`, a relative one once the cwd is lost) loses
 * the cwd, and what the commands after it name relative to it is the
 * per-command gate's to judge, in the real one: judged in the cwd the
 * walk last knew, `cd "$d" && rm x` refused a line that removes an
 * allowed file.
 */
function afterCd(
  words: readonly Word[],
  session: SessionState,
  lost: boolean,
): [SessionState, boolean] {
  const head = words[0]
  if (head === undefined || wordValue(head) !== 'cd') return [session, lost]
  const target = words.length === 2 ? (words[1]?.text ?? null) : null
  if (target === null || target.startsWith('-') || (lost && !target.startsWith('/'))) {
    return [session, true]
  }
  const predicted = session.fork({ cwd: resolvePath(target, session.cwd) })
  return [predicted, false]
}

/**
 * Every command of a line with the session it is judged in.
 *
 * The cwd is the one fact that moves as a line runs, and both readers
 * of a line need the same answer about it: a host asking what a line
 * would do and the pass deciding whether to let it run cannot differ,
 * or `explain` would report an allow the run then refuses. The redirects
 * ride along for the same reason: they are read here so both readers
 * judge the file the shell opens, not just the operands.
 */
function* walkedLine(
  root: TSNodeLike,
  session: SessionState,
  reparse: (line: string) => TSNodeLike,
  frame: Frame | null = null,
  lost = false,
): Generator<Walked> {
  yield* walkNode(root, session, homeDir(session), frame ?? rootFrame(root, null), reparse, lost)
}

/**
 * Whether an explanation refuses the line's intent, rather than just
 * failing one command.
 *
 * Explicit deny rules and command-scoped policy refusals hold the line.
 * Operand-scoped filesystem refusals wait for the per-command gate,
 * where earlier commands have established the live cwd and namespace.
 * Rule-less DENY results also wait: an unavailable head word, an
 * uncovered command, or words only the runtime can expand fail where
 * they occur rather than against the whole line.
 */
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
function isJudged(expl: Judgment): boolean {
  return expl.exitCode === 0 || isVerdict(expl)
}

/**
 * Whether an explanation refuses the command outright, rather than
 * reporting a line that would run or a question the host has not
 * answered.
 */
function refuses(expl: Judgment): boolean {
  return expl.exitCode !== 0 && !isPendingRefusal(expl.refusal)
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

function isVerdict(expl: Judgment): boolean {
  if (expl.exitCode === 0) return false
  if (expl.rule !== null && expl.outcome === Outcome.DENY) return true
  // Filesystem refusals use the live cwd and fail only their command.
  if (expl.refusal?.scope === 'operand') return false
  return expl.rule !== null || expl.outcome === Outcome.ALLOW
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
  agentId: string,
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
): Promise<[Walked, Judged[]][]> {
  const judged: [Walked, Judged[]][] = []
  const frame = rootFrame(root, handed.origin)
  for (const item of walkedLine(root, session, reparse, frame)) {
    if (item.words[0]?.text === null) continue
    judged.push([
      item,
      await judgeWords(
        item.words,
        item.occurrence,
        item.session,
        registry,
        namespace,
        agentId,
        reparse,
        item.redirects,
        true,
        null,
        item.intrinsic,
        false,
        item.lost,
      ),
    ])
  }
  return judged
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
 * A head word the session cannot see is a routing miss, so it stays
 * bash and a typo cannot cost an agent the work the line already did; a
 * word only the runtime can expand is judged where it is expanded, by
 * the per-command gate, which sees the real path.
 *
 * That second one is the limit of the hold, and it is worth stating
 * plainly: this pass reads the *text* of a line, while the gate reads
 * its *values*, so a path the runtime computes (`cat $S`, `$( )`, a
 * `cd` whose argument is a variable) is invisible here. The rule is
 * still enforced, by the gate, but the earlier commands have run by
 * then. For a deny that costs allowed side effects and nothing more,
 * since the commands that ran were on the allow list. For an ask it
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
 * Every command is judged whether or not the session carries a document.
 * Command-scoped coded policies can hold the line without a named rule.
 * Operand-scoped policies, including MountRootPolicy, remain the
 * per-command gate's responsibility.
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
  agentId: string,
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
  const judged =
    made ?? (await lineJudgments(root, session, registry, namespace, agentId, handed, reparse))
  if (judged.reduce((n, [, explained]) => n + explained.length, 0) < 2) return null
  for (const [item, explained] of judged) {
    const walked = item.session
    const targets = redirectPaths(item.redirects, registry, walked.cwd)
    for (const [index, one] of explained.entries()) {
      const expl = one.judgment
      if (!isJudged(expl) || !asksFor(one)) continue
      const args = [...expl.argv]
      const classified = classifiedWords(expl.command, args, walked, registry)
      const answered = await admit(
        expl.command,
        args,
        classified.slice(1),
        walked,
        registry,
        namespace,
        agentId,
        null,
        // judgeWords lists the statement's own command first and the
        // lines it runs after it, so only the first explanation is the
        // command the redirects belong to.
        index === 0 ? targets : [],
        signal,
        // This pass judges on the gate's behalf and runs nothing itself, so
        // a grant the host gives here is claimed for the per-command gate
        // that runs the line, and spent when the line ends: one question per
        // run, not per pass.
        { line: handed, occurrence: one.occurrence },
        one.intrinsic,
        one.unread,
      )
      if (!(answered instanceof Admitted)) return answered
      // The host answered this one inline. The rest of the line has not
      // been judged yet, so the scan goes on: stopping here let a later
      // command's deny run behind an approval.
    }
  }
  return null
}

/**
 * Whether a verdict's answer refuses the command, putting an
 * unanswered ask's question to the host.
 *
 * The chain is asked again rather than the explanation re-read,
 * because `Judgment.outcome` is the document's answer: a coded
 * policy's ask arrives with whatever the document said, so only the
 * chain's own answer separates a deny from an ask. A deny refuses
 * outright. An ask's settled record is read without being spent
 * (`Decisions.held`), so the gate that then runs the line consumes the
 * same answer, in its own voice and behind the line's redirections; an
 * unanswered rule is raised through the same ledger the gate reads, so
 * the answer lands exactly once and the gate does not ask again.
 */
async function verdictRefuses(
  judged: Judged,
  redirects: readonly PathSpec[],
  walked: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  // The line's hand-off, on which an answer given here is claimed for
  // the gate.
  handed: HandOff,
  signal?: AbortSignal,
): Promise<boolean> {
  const expl = judged.judgment
  const claimant: Claimant = { line: handed, occurrence: judged.occurrence }
  const args = [...expl.argv]
  const classified = classifiedWords(expl.command, args, walked, registry)
  const gated = await gate(
    expl.command,
    args,
    classified.slice(1),
    walked,
    registry,
    namespace,
    agentId,
    null,
    redirects,
    judged.intrinsic,
    judged.unread,
  )
  if (!Array.isArray(gated)) return true
  const [ctx, asked] = gated
  if (asked?.kind !== 'ask') return asked !== null
  const standing = await registry.decisions.held(ctx, asked, claimant)
  if (standing === null) return false
  if (standing.kind === 'deny') return true
  // handOff: this pass exists to decide whether a secret is fetched, and the
  // gate behind it still has to admit the line. An answer given here is
  // claimed for that gate, which runs on it, so the host is asked once.
  const action = await registry.decisions.resolve(ctx, asked, signal, claimant)
  if (action !== null && action.kind === 'abandoned') throw makeAbortError()
  return action !== null
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
    stack.push(...current.namedChildren)
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
 * unanswered ask through the ledger the gate reads.
 */
async function commandRefused(
  item: Walked,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  handed: HandOff,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
): Promise<boolean> {
  const walked = item.session
  const explained = await judgeWords(
    item.words,
    item.occurrence,
    walked,
    registry,
    namespace,
    agentId,
    reparse,
    item.redirects,
    true,
    null,
    false,
    false,
    item.lost,
  )
  const targets = redirectPaths(item.redirects, registry, walked.cwd)
  for (const [index, judged] of explained.entries()) {
    // A question about a spelling the runtime completes is the gate's
    // (`asksFor`); the node is kept, and over-keeping only ever
    // over-fetches.
    if (!isVerdict(judged.judgment) || !asksFor(judged)) continue
    // judgeWords lists the statement's own command first and the
    // lines it runs after it, so only the first explanation is the
    // command the redirects belong to.
    if (
      await verdictRefuses(
        judged,
        index === 0 ? targets : [],
        walked,
        registry,
        namespace,
        agentId,
        handed,
        signal,
      )
    ) {
      return true
    }
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
  agentId: string,
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
    if (await commandRefused(item, registry, namespace, agentId, handed, reparse, signal)) {
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
 * other words (`Judged.stated` false) is left to it. A head word the
 * session cannot see fails where it stands while the rest of its line
 * runs, so it does not hold the line. Mirrors the Python `line_held`.
 */
export async function lineHeld(
  judged: readonly [Walked, Judged[]][],
  registry: MountRegistry,
  handed: HandOff,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const [, explained] of judged) {
    for (const one of explained) {
      const expl = one.judgment
      if (!isVerdict(expl) || expl.exitCode === 0) continue
      if (refuses(expl)) return true
      const asked = expl.answers.find((a): a is Ask => a.kind === 'ask')
      if (one.ctx === undefined || asked === undefined || !one.stated) continue
      const action = await registry.decisions.resolve(one.ctx, asked, signal, {
        line: handed,
        occurrence: one.occurrence,
      })
      if (action !== null) {
        if (action.kind === 'abandoned') throw makeAbortError()
        return true
      }
    }
  }
  return false
}

/**
 * Whether some command's judgment is a verdict that refuses it or waits
 * on the host (`isVerdict`), the line-level answer placement waits on.
 * Mirrors the Python `holds`.
 */
export function holds(judgments: readonly Judgment[]): boolean {
  return judgments.some((one) => isVerdict(one) && one.exitCode !== 0)
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
 * The words are read literally, as `admitLine` reads them, so nothing is
 * expanded and no `$( )` runs. `wholeLine` is whether a runtime takes the
 * line whole, which reads it as typed; the executor's gate reads each
 * command once expanded.
 */
export async function explainLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  wholeLine = false,
): Promise<Judged[]> {
  return judgeLine(
    root,
    session,
    registry,
    namespace,
    agentId,
    reparse,
    rootFrame(root, null),
    true,
    wholeLine,
    false,
    true,
  )
}

/**
 * A line's public explanation: its verdict and its parse tree, with every
 * command's explanation where the command stands. The verdict is the
 * first command, in the order the gate reads them, whose refusal holds
 * the whole line (`holds`), as the run reports it; a line nothing holds
 * runs, carrying the first ask an approval lets through. A command
 * refused only where it stands keeps its refusal to its own node, since
 * the rest of the line still runs. Every scope a command reads its words in (the typed line, a `$( )` body, a
 * `bash -c` string) is parsed on its own with `reparse`, as the nested
 * line will be; a judgment is placed on the command at its span in that
 * scope, and a nested scope under the command holding it. Mirrors the
 * Python `explained_line`.
 */
export function explainedLine(
  line: string,
  judged: readonly Judged[],
  runtimeOf: (command: string) => string,
  reparse: (line: string) => TSNodeLike,
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
  const node = scopeNode('line', root, scopes, runtimeOf, reparse)
  const held = judged.find((one) => one.judgment.exitCode !== 0 && isVerdict(one.judgment))
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
      refusal: judgment.refusal,
      exitCode: judgment.exitCode,
      stderr: judgment.stderr,
    }
  }
  const asked = judged.find(
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
    refusal: null,
    exitCode: 0,
    stderr: '',
  }
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
 * A command's outcome, reason and source as its explanation states them:
 * the refusal it meets (`ASK` for a question waiting on the host, `DENY`
 * for any other, a policy that failed included), else the ask an approval
 * lets through, else `DENY` for a word the allow list refuses. The reason
 * and source are the deciding answer's, which a coded policy may give over
 * the document's own. Mirrors the Python `_verdict_of`.
 */
function verdictOf(judgment: Judgment): [Outcome, string, string] {
  const decider =
    judgment.answers.find((a) => a.kind === 'deny') ??
    judgment.answers.find((a) => a.kind === 'ask') ??
    null
  const source =
    decider?.rule !== undefined
      ? sourceOf(decider.rule)
      : judgment.source === 'commands.allow'
        ? judgment.source
        : ''
  const refusal = judgment.refusal
  if (refusal !== null) {
    return [refusal.kind === 'pending' ? Outcome.ASK : Outcome.DENY, refusal.reason, source]
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
  runtimeOf: (command: string) => string,
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
        runtimeOf,
        reparse,
      ),
    )
  }
  const convert = (node: TSNodeLike): (ShellNode | CommandExplanation)[] => {
    const start = node.startIndex ?? 0
    const end = node.endIndex ?? 0
    if (node.type === NodeType.COMMAND) {
      const kids = take(start, end)
      const span = `${String(start)}:${String(end)}`
      const ones = mine.get(span) ?? []
      mine.delete(span)
      if (ones.length === 0) return [{ type: 'command', text: getText(node), children: kids }]
      return ones.map((one, i) => commandOf(one, getText(node), i === 0 ? kids : [], runtimeOf))
    }
    if (SUBSTITUTIONS.has(node.type)) return take(start, end)
    const inner = node.namedChildren.flatMap(convert)
    const shape = SHAPES.get(node.type)
    return shape === undefined ? inner : [{ type: shape, text: getText(node), children: inner }]
  }
  const children = convert(reparse(text))
  for (const [span, ones] of mine) {
    const [start, end] = span.split(':').map(Number)
    const spoken = text.slice(start, end)
    children.push(...ones.map((one) => commandOf(one, spoken, [], runtimeOf)))
  }
  children.push(...take(0, Number.MAX_SAFE_INTEGER))
  return { type: kind, text, children }
}

/** One command's public explanation. Mirrors the Python `_command_of`. */
function commandOf(
  one: Judged,
  text: string,
  children: readonly ShellNode[],
  runtimeOf: (command: string) => string,
): CommandExplanation {
  const judgment = one.judgment
  const [outcome, reason, source] = verdictOf(judgment)
  return {
    type: 'command',
    command: judgment.command,
    argv: judgment.argv,
    exitCode: judgment.exitCode,
    stderr: judgment.stderr,
    outcome,
    reason,
    source,
    answers: judgment.answers,
    refusal: judgment.refusal,
    runtime: runtimeOf(judgment.command),
    operands: judgment.operands,
    text,
    children,
  }
}

/**
 * Every command of a line explained, in the order the gate reads them,
 * each with its place on the line. `frame` is the scope the line is
 * read in; `stated` is whether the line's text reaches here as the gate
 * will read it, and `wholeLine` whether a runtime takes it whole, as
 * `judgeWords` takes them; `lost` is whether the line begins with its cwd
 * lost, as a line a command runs after such a `cd` does; `every` asks
 * every policy past a Deny, for `explain`.
 */
async function judgeLine(
  root: TSNodeLike,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  frame: Frame,
  stated = true,
  wholeLine = false,
  lost = false,
  every = false,
): Promise<Judged[]> {
  const out: Judged[] = []
  for (const item of walkedLine(root, session, reparse, frame, lost)) {
    out.push(
      ...(await judgeWords(
        item.words,
        item.occurrence,
        item.session,
        registry,
        namespace,
        agentId,
        reparse,
        item.redirects,
        stated,
        null,
        item.intrinsic,
        wholeLine,
        item.lost,
        every,
      )),
    )
  }
  return out
}

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

import { sessionPathAllowed } from '../../context/session_context.ts'
import type { ByteSource } from '../../io/types.ts'
import {
  Outcome,
  PolicyDenied,
  Scope,
  askRule,
  refusalOf,
  renderDeny,
  renderPending,
} from '../../policy/index.ts'
import type {
  Ask,
  Claimant,
  CommandContext,
  CommandRule,
  AdmissionRules,
  Deny,
  HandOff,
} from '../../policy/index.ts'
import { ioRefusal } from '../../policy/match/rule.ts'
import { hasRules, readsArgs, scopesPaths } from '../../policy/match/reads.ts'
import type { ValueType } from '../../commands/spec/types.ts'
import { commandNodes } from '../../runtime/routing/index.ts'
import {
  getParts,
  getRedirects,
  getText,
  literalWord,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import { NodeType, RedirectKind } from '../../shell/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { PathSpec, type Refusal } from '../../types.ts'
import type { EntryGate } from '../../types.ts'
import { isGlob } from '../../utils/hidden.ts'
import { CycleError, resolvePath } from '../../utils/path.ts'
import { makeAbortError } from '../abort.ts'
import { toScope } from '../executor/builtins/scope.ts'
import { followPaths } from '../executor/builtins/links/links.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  pathFlagScopes,
  positionalScopes,
  programTokens,
} from '../executor/command/routing.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import { specForCommand, specWordBases, specWordKinds } from '../expand/spec_hints.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import {
  SHELL_NAMES,
  SLASH_KEEPS_LAST,
  WordPolicy,
  followsLastComponent,
  isTool,
  listed,
  readsSubtrees,
  lookup,
  walksMounts,
  wordPolicy,
} from '../lookup/index.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { innerLines, innerReadable, wordValue, type Word } from './inner_lines.ts'
import {
  argvFrame,
  type Frame,
  lineFrame,
  occurrenceIn,
  rootFrame,
  wholeOccurrence,
} from './occurrence.ts'

/**
 * What the command plane prints when a line does not get to run: 127
 * for a word the session cannot see, 126 for a whole-command refusal
 * or an unanswered ask, the operand code (1, tar 2) for an
 * operand-scoped refusal. `refusal` is the record the result carries
 * beside stderr, null on the 127 row, which must not say the word
 * names anything. Mirrors the Python `Refused`.
 */
export interface Refused {
  readonly stderr: Uint8Array
  readonly exitCode: number
  readonly refusal: Refusal | null
}

/**
 * Whether a refusal is a question the host has not answered yet, which
 * holds the line for its retry rather than ending it.
 */
/**
 * Whether a record is a question the host has not answered yet, which
 * holds the line for its retry rather than ending it.
 */
export function isPendingRefusal(refusal: Refusal | null): boolean {
  return refusal !== null && refusal.kind === 'pending'
}

export function isPending(refused: Refused): boolean {
  return refused.refusal?.kind === 'pending'
}

function norm(virtual: string): string {
  return virtual.replace(/\/+$/, '') || '/'
}

/**
 * The nodes a redirected statement may wrap whose last command is the
 * one the redirect binds to.
 */
const REDIRECT_CHAIN: ReadonlySet<string> = new Set([NodeType.LIST, NodeType.PIPELINE])

/**
 * A command the gate let through, and what its own I/O may touch.
 *
 * The gate judged the paths the line names; a walk below them reaches
 * entries no rule has seen, so the dispatcher binds this to the session
 * context for the command's run and the commands tier asks it before each
 * read, write or listing (`EntryGate`). The paths the gate already judged
 * pass, since the line was admitted on them; every other entry is judged
 * by `ioRefusal` under the same precedence the gate applied to the line,
 * and a refusal is the op door's `PolicyDenied` (EACCES, the reason, the
 * path), which every command renders as GNU's `Permission denied`.
 * `granted` holds the ask rules the line runs under a grant for: the one
 * the door answered for this line, and the session's standing ones.
 */
export class Admitted implements EntryGate {
  readonly rules: AdmissionRules | null
  readonly tokens: readonly string[]
  readonly judged: ReadonlySet<string>
  readonly granted: readonly CommandRule[]
  readonly scoped: boolean

  constructor(init: {
    rules: AdmissionRules | null
    tokens: readonly string[]
    judged: ReadonlySet<string>
    granted: readonly CommandRule[]
    scoped: boolean
  }) {
    this.rules = init.rules
    this.tokens = init.tokens
    this.judged = init.judged
    this.granted = init.granted
    this.scoped = init.scoped
  }

  // Throw `PolicyDenied` when a rule in force refuses this entry for the
  // running command.
  check(virtual: string): void {
    if (this.judged.has(norm(virtual))) return
    const reason = ioRefusal(this.rules, this.tokens, virtual, this.granted)
    if (reason !== null) throw new PolicyDenied(reason, virtual)
  }
}

/**
 * The paths a path-pattern guard reads for a line: the operands as
 * typed and the values of path-valued flags, then, for a command that
 * follows links, the targets they resolve to. `cat /data/link` reads
 * `/data/secret`, so a rule protecting the target has to see it, and a
 * command-scoped rule never runs at the op door where the resolved path
 * would otherwise be checked. The follow policy is the command's own
 * (`followsLastComponent`: rm, mv, ln, stat, tar ... act on the link
 * itself, `-L` turns following back on), the same one the router
 * applies to the operands before the handler runs, so a rule sees
 * exactly the path the command will touch. A loop is left to that later
 * step to report; here the typed paths stand. Then the operand a bare
 * `ls`/`find`/`du`/`tree`/`grep -r` implies, the working directory,
 * which the executor injects after the gate and which a rule on that
 * directory has to see. Last come the statement's redirect targets:
 * `cat < /data/secret` reads the file and `echo x > /data/secret`
 * truncates it, on the shell's own fds outside the admitted command's
 * gate window, so the admission is the one place a rule can see them. A
 * redirect always dereferences (the shell opens the target), so its
 * link targets ride along whatever the command's own follow policy
 * says.
 */
export function policyScopes(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  namespace: Namespace | null,
  cwd: string,
  implied: PathSpec | null = null,
  redirects: readonly PathSpec[] = [],
): PathSpec[] {
  const scopes: PathSpec[] = []
  for (const p of operands) {
    if (p instanceof PathSpec) scopes.push(p)
  }
  scopes.push(...pathFlagScopes(name, [...args], cwd))
  if (name.includes('/')) {
    // A slash-carrying head word is a file the line executes, and it
    // lives in argv[0], not the operands, so a path-pattern guard would
    // never see it without this row.
    scopes.unshift(toScope(resolvePath(name, cwd)))
  }
  if (namespace !== null && namespace.nodes.size > 0 && operands.length > 0) {
    let followed: (string | PathSpec)[] = []
    try {
      followed = followPaths(
        namespace,
        [...operands],
        followsLastComponent(name, [name, ...args]),
        !SLASH_KEEPS_LAST.has(name),
      )
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
    }
    const seen = new Set(scopes.map((p) => p.virtual))
    for (const item of followed) {
      if (item instanceof PathSpec && !seen.has(item.virtual)) {
        seen.add(item.virtual)
        scopes.push(item)
      }
    }
  }
  if (implied !== null && !scopes.some((p) => p.virtual === implied.virtual)) {
    scopes.push(implied)
  }
  if (redirects.length > 0) {
    const targets: (string | PathSpec)[] = [...redirects]
    if (namespace !== null && namespace.nodes.size > 0) {
      let followed: (string | PathSpec)[] = []
      try {
        followed = followPaths(namespace, [...redirects], true)
      } catch (err) {
        if (!(err instanceof CycleError)) throw err
      }
      targets.push(...followed.filter((p) => p instanceof PathSpec))
    }
    const seen = new Set(scopes.map((p) => p.virtual))
    for (const item of targets) {
      if (item instanceof PathSpec && !seen.has(item.virtual)) {
        seen.add(item.virtual)
        scopes.push(item)
      }
    }
  }
  return scopes
}

/**
 * The paths of a line the session can see. A hidden path is nonexistent
 * for the session, so no policy may learn of it either: a rule scoped
 * to it must not fire (the reason would say the path is there), an ask
 * must not be raised for it (a request would name it to the host), and
 * the line runs on to the door, which answers ENOENT like any other
 * absent path.
 */
function seen(session: Session, specs: readonly PathSpec[]): PathSpec[] {
  return specs.filter((p) => sessionPathAllowed(session, p.virtual))
}

/**
 * The command plane's admission of one command: visibility, then the
 * policy chain, then the approval door. The one gate every command
 * class passes through, in the tree (`runArgv`, once the words are
 * expanded) and for a line a runtime takes whole (`admitLine`, per
 * parsed command). A word the session's allow lists do not install is
 * bash's "command not found" before any admission hook, so an unlisted
 * tool never leaks a deny reason; a path the session cannot see is
 * dropped before any hook, so a rule never names it and the door
 * answers ENOENT; a Deny renders in the outcome table's voice; an Ask
 * is answered by the door from the session's grants or the host.
 * `agentId` is the agent the line is attributed to, for an approval
 * request; `stdin` decides whether a bare `rg` reads the working
 * directory.
 */
/**
 * One command's literal words, classified the way the runtime would
 * classify them, so the gate and the run name the same paths.
 */
export function classifiedWords(
  name: string,
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): (string | PathSpec)[] {
  const line = [name, ...args]
  const [wordKinds, wordBases] = wordHints(line, session, registry)
  return classifyParts(line, registry, session.cwd, wordKinds, wordBases)
}

/**
 * The paths a statement's redirect targets name.
 *
 * Shared by admission and by the dry run, because a rule reads a
 * redirect the same way in both: a target only the runtime can expand
 * names no path here, and one that is not path-shaped is not a file.
 */
export function redirectPaths(
  words: readonly Word[],
  registry: MountRegistry,
  cwd: string,
): PathSpec[] {
  return words
    .filter((w) => w.text !== null)
    .map((w) => classifyBarePath(wordValue(w), registry, cwd))
    .filter((p): p is PathSpec => p instanceof PathSpec)
}

/**
 * Everything the gate decides about one command before anything is
 * spent on it: visibility, the classified context, and the policy
 * chain's answer.
 *
 * Split out of `admit` so a dry run can have the answer without the
 * consequences. Nothing here records a request, consumes a grant or
 * reaches the host, which is what makes it safe for `explain`;
 * `admit` adds exactly those and renders.
 *
 * `definedFn` is the caller vouching the head word is a shell function
 * defined by run time. The provision walk vouches for a function its
 * own script defines — the run stores that definition in the session
 * before the call, a dry run keeps it in plan state, where neither
 * `commandVisible` nor `isTool` can see it. The word is then judged
 * exactly as the run would judge it: exempt from the allow lists
 * unless a builtin shadows it (`SHELL_NAMES`), and `ctx.tool` false
 * accordingly.
 */
export async function gate(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId = '',
  stdin: ByteSource | null = null,
  redirects: readonly PathSpec[] = [],
  definedFn = false,
): Promise<Refused | [CommandContext, Deny | Ask | null]> {
  const tool = definedFn ? SHELL_NAMES.has(name) : isTool(name, session)
  if (tool && !listed(name, session)) {
    return {
      stderr: new TextEncoder().encode(`${name}: command not found\n`),
      exitCode: 127,
      refusal: null,
    }
  }
  const [tokens, program] = programTokens(registry, name, [...args], session.cwd)
  const implied =
    name in CWD_DEFAULT_RAW
      ? defaultCwdOperand([name, ...operands], name, registry, session.cwd, stdin)
      : null
  const ctx: CommandContext = {
    command: name,
    paths: seen(
      session,
      policyScopes(name, args, operands, namespace, session.cwd, implied, redirects),
    ),
    operands: seen(session, positionalScopes(name, [...args], session.cwd, [...operands])),
    argv: [...args],
    cwd: session.cwd,
    registry,
    sessionId: session.sessionId,
    agentId,
    tokens,
    program,
    tool,
    walks: walksMounts(name, [name, ...args]),
  }
  return [ctx, await registry.policies.preCommand(ctx)]
}

export async function admit(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId = '',
  stdin: ByteSource | null = null,
  redirects: readonly PathSpec[] = [],
  // The run's abort signal, carried only so a question put to a host
  // cannot outlive the run that raised it. Nothing else here waits on
  // anything outside mirage.
  signal?: AbortSignal,
  // The command and its line, null outside a line. On a line, every
  // grant behind the command is claimed on the line's hand-off for that
  // occurrence, whether a pass that judges the line before it runs
  // (`prejudgeLine`, `admitLine`) or the gate that runs it is reading,
  // and spent when the line ends, so one question covers one run rather
  // than one reader; a reader outside a line spends what it matched. A
  // refusal needs no such care: the record refuses the agent's retry
  // from the ledger either way.
  claimant: Claimant | null = null,
): Promise<Refused | Admitted> {
  const gated = await gate(
    name,
    args,
    operands,
    session,
    registry,
    namespace,
    agentId,
    stdin,
    redirects,
  )
  if (!Array.isArray(gated)) return gated
  const [ctx, asked] = gated
  // An Ask is the chain's answer only after every Deny had its say; the
  // door answers it from the session's grants or the host, so a grant
  // never re-opens a deny.
  const action =
    asked !== null && asked.kind === 'ask'
      ? await registry.decisions.resolve(ctx, asked, signal, claimant)
      : asked
  // The ledger stopped waiting on a host because this run was killed
  // while it was deciding. That is the kill landing late, not a ruling,
  // so it joins every other abandoned wait rather than being rendered
  // as a refusal the document never made.
  if (action !== null && action.kind === 'abandoned') throw makeAbortError()
  if (action === null) {
    const granted = session.decisions
      .filter((r) => r.scope === Scope.SESSION && r.outcome === Outcome.ALLOW)
      .map((r) => r.rule)
    if (asked !== null && asked.kind === 'ask') granted.unshift(askRule(ctx, asked))
    const rules = session.commands
    return new Admitted({
      rules,
      tokens: ctx.tokens ?? [],
      judged: new Set(ctx.paths.map((p) => norm(p.virtual))),
      granted,
      scoped: scopesPaths(rules, name),
    })
  }
  const [stderr, exitCode] =
    action.kind === 'pending' ? renderPending(name, action) : renderDeny(name, action)
  return { stderr, exitCode, refusal: refusalOf(action) }
}

function refuse(name: string, reason: string): Refused {
  const deny: Deny = { kind: 'deny', reason, scope: 'command' }
  const [stderr, exitCode] = renderDeny(name, deny)
  return { stderr, exitCode, refusal: refusalOf(deny) }
}

function unreadable(raw: string): string {
  return `cannot read ${raw} before the runtime expands it`
}

/**
 * The spec's per-position classification hints for a literal line, the
 * way `expandArgv` computes them for an expanded one. Without them a
 * bare filename operand stays text (`cat secret` from `/data` yields no
 * `/data/secret` scope) and a chdir option (tar's `-C`) resolves later
 * words against the wrong base, so a rule and the run would disagree
 * about the paths the line names.
 */
function wordHints(
  line: readonly string[],
  session: Session,
  registry: MountRegistry,
): [(ValueType | null)[] | null, (string | null)[] | null] {
  const consumed = registry.matchCommandPrefix([...line])
  const joined = line.slice(0, consumed).join(' ')
  if (
    Object.hasOwn(session.functions, joined) ||
    wordPolicy(lookup(joined, session, registry)) !== WordPolicy.MOUNT
  ) {
    return [null, null]
  }
  const spec = specForCommand(joined, registry, session.cwd)
  if (spec === null) return [null, null]
  const extra: (ValueType | null)[] = new Array<ValueType | null>(consumed - 1).fill('str')
  const wordKinds = [...extra, ...specWordKinds(spec, [...line.slice(consumed)], joined)]
  const bases = specWordBases(spec, [...line.slice(consumed)], session.cwd)
  const wordBases =
    bases === null ? null : [...new Array<string | null>(consumed - 1).fill(null), ...bases]
  return [wordKinds, wordBases]
}

/**
 * Admit one command of a whole line on the words the gate read, then
 * whatever lines the command runs in turn. `open` says the runtime
 * appends operands the gate cannot read (`xargs`, `find -exec`);
 * `redirectWords` are the statement's redirect targets, as the gate
 * reads them.
 */
async function admitWords(
  words: readonly Word[],
  open: boolean,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  rules: AdmissionRules | null,
  reparse: (line: string) => TSNodeLike,
  redirectWords: readonly Word[] = [],
  signal?: AbortSignal,
  // The command and its line, as `admit` takes it (the lines it runs
  // stand under it).
  claimant: Claimant | null = null,
): Promise<Refused | null> {
  const head = words[0]
  if (head === undefined) return null
  if (head.text === null && hasRules(rules)) return refuse(head.raw, unreadable(head.raw))
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const line = [name, ...args]
  const classified = classifiedWords(name, args, session, registry)
  const redirects = redirectPaths(redirectWords, registry, session.cwd)
  const verdict = await admit(
    name,
    args,
    classified.slice(1),
    session,
    registry,
    namespace,
    agentId,
    null,
    redirects,
    signal,
    claimant,
  )
  if (!(verdict instanceof Admitted)) return verdict
  if (verdict.scoped) {
    // The runtime walks and globs on its own, where no entry gate
    // follows an I/O below the judged words, so a command a path or
    // mount rule reads must not reach it with either in hand.
    if (readsSubtrees(name, line)) {
      return refuse(name, 'walks a tree the gate cannot follow')
    }
    const globby = [...classified.slice(1), ...redirects].some(
      (p) => p instanceof PathSpec && isGlob(p.rawPath || p.virtual),
    )
    if (globby) return refuse(name, 'expands a pattern only the runtime can read')
  }
  const unread = [...words.slice(1), ...redirectWords].find((w) => w.text === null)?.raw
  if ((unread !== undefined || open) && readsArgs(rules, name)) {
    return refuse(
      name,
      unread !== undefined ? unreadable(unread) : 'runs on operands the gate cannot read',
    )
  }
  for (const inner of innerLines(name, words.slice(1))) {
    if (!innerReadable(inner)) {
      if (hasRules(rules)) return refuse(name, 'runs lines the gate cannot read')
      continue
    }
    let innerRefusal: Refused | null
    if (inner.line !== null) {
      innerRefusal = await admitLine(
        reparse(inner.line),
        session,
        registry,
        namespace,
        agentId,
        reparse,
        signal,
        claimant?.line ?? null,
        claimant === null ? null : lineFrame(inner.line, claimant.occurrence),
        inner.open,
      )
    } else {
      const within: Claimant | null =
        claimant === null
          ? null
          : {
              line: claimant.line,
              occurrence: wholeOccurrence(
                argvFrame(inner.argv.map(wordValue), claimant.occurrence),
              ),
            }
      innerRefusal = await admitWords(
        inner.argv,
        inner.open,
        session,
        registry,
        namespace,
        agentId,
        rules,
        reparse,
        [],
        signal,
        within,
      )
    }
    if (innerRefusal !== null) return innerRefusal
  }
  return null
}

/**
 * Admit every command of a line a runtime takes whole. A whole line is
 * a command like any other, but the runtime does the expanding, so the
 * gate reads the line as typed: each command is admitted on its literal
 * words (quotes removed, escapes resolved, a path-shaped word a path, an
 * installed CLI's verb path walked), and the first refusal is the
 * line's. A word only the runtime can expand (`$cmd`, `"$p"`, `$(...)`,
 * `{a,b}`) is refused wherever a rule in force would have read it: as
 * the command name whenever the session has any command rule, as an
 * argument when a rule reads that command's arguments (a pattern with a
 * token after the name, a path-scoped or mount-scoped rule). The words
 * that run other words (`eval`, `sh -c`, `xargs`, `env` ... see
 * `innerLines`) have those lines admitted in turn, and a line the gate
 * cannot read at all (a sourced file, a script, `eval "$p"`) is refused
 * under any command rule. A statement's redirect targets are read as
 * words of its command, so `cat < /data/secret` is judged on the file
 * it opens. A command a path or mount rule reads is refused outright
 * when its I/O would pass the judged words — a walk (`find`,
 * `grep -r`, `tar -c`) or a glob only the runtime expands — because
 * every line executor acts outside the entry gate (a remote sandbox's
 * own disk, a host process), so a walk the gate cannot follow does not
 * run; a runtime whose I/O rides the dispatcher could relax this by
 * carrying the gate. With no rule in force nothing is refused on this
 * account: the words are admitted as typed, which is all a coded
 * policy ever saw. `reparse` parses the text a word runs (`eval`,
 * `sh -c`) the way the line reader parsed the line.
 *
 * No gate follows this pass: the runtime runs the line whole, so every
 * grant it matches is claimed on the line's hand-off exactly as any
 * reader on a line claims, and the executor's sweep spends them when
 * the line ends. A line held on a question still waiting keeps its
 * earlier answers standing for the retry, exactly as the compound-line
 * pass does, where spending them here asked the human again for each on
 * every retry. `handed` is null outside a line (a bare admission with
 * no run behind it). `frame` is the scope the line is read in, for a
 * line a word runs; null reads `root` as the line itself. `open` says
 * the runtime appends operands the gate cannot read to the line
 * (`mapfile -C`'s callback, which runs with the index and the record
 * after it), as `admitWords` takes it for each of its commands.
 */
export async function admitLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  signal?: AbortSignal,
  handed: HandOff | null = null,
  frame: Frame | null = null,
  open = false,
): Promise<Refused | null> {
  const rules = session.commands
  const home = homeDir(session)
  const scope = frame ?? rootFrame(root, handed?.origin ?? null)
  for (const node of commandNodes(root)) {
    const [, parts] = splitEnvPrefix(getParts(node))
    const words: Word[] = parts.map((part) => ({
      raw: getText(part),
      text: literalWord(part, home),
    }))
    if (words.length === 0) continue
    const refusal = await admitWords(
      words,
      open,
      session,
      registry,
      namespace,
      agentId,
      rules,
      reparse,
      statementRedirects(node, home),
      signal,
      handed === null ? null : { line: handed, occurrence: occurrenceIn(node, scope) },
    )
    if (refusal !== null) return refusal
  }
  return null
}

/**
 * The redirect targets of the statement holding a command, as the gate
 * reads its words: the raw text and the literal it names, null when
 * only the runtime can expand it (refused wherever a rule reads the
 * command's arguments, like any other word). Heredoc and herestring
 * bodies are content, not paths, and a numeric target is an fd
 * duplication; neither names a file.
 *
 * A redirect binds to one command, and which one is a question about
 * the tree rather than the statement: `a && b > f` and `a | b > f` both
 * parse as a redirected_statement wrapping the whole list, so reading
 * only its first child answered `a` and left `b`, the command bash
 * actually opens the file for, with no target at all. The walk climbs
 * the last-command chain instead, which is bash's own rule for a list
 * and a pipeline. A compound (`{ }`, a loop, a subshell) redirects
 * every command inside it, which is not a chain, so none is claimed
 * here and the op door judges the write.
 */
export function statementRedirects(node: TSNodeLike, home: string | null): Word[] {
  let owner = node
  let parent = owner.parent
  while (parent !== undefined && parent !== null && REDIRECT_CHAIN.has(parent.type)) {
    const last = parent.namedChildren[parent.namedChildren.length - 1]
    if (last === undefined || last.startIndex !== owner.startIndex) return []
    owner = parent
    parent = owner.parent
  }
  if (parent === undefined || parent === null) return []
  if (parent.type !== NodeType.REDIRECTED_STATEMENT) return []
  const body = parent.namedChildren[0]
  if (body === undefined || body.startIndex !== owner.startIndex) return []
  const [, redirects] = getRedirects(parent)
  const words: Word[] = []
  for (const r of redirects) {
    if (
      r.kind === RedirectKind.HEREDOC ||
      r.kind === RedirectKind.HERESTRING ||
      r.kind === RedirectKind.AMBIGUOUS
    )
      continue
    if (typeof r.target === 'number' || r.targetNode === null) continue
    const target = r.targetNode as TSNodeLike
    words.push({ raw: String(r.target), text: literalWord(target, home) })
  }
  return words
}

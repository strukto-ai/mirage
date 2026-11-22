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

import { leafOptions, walk } from '../../commands/cli/walk.ts'
import type { CLI } from '../../commands/cli/types.ts'
import type { ValueType } from '../../commands/spec/types.ts'
import { callerSignal, currentCaller, sessionAccess } from '../../context/session_context.ts'
import type { ByteSource } from '../../io/types.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import type {
  AdmissionRules,
  Ask,
  Claimant,
  CommandContext,
  CommandRule,
  Deny,
  Pending,
  Route,
} from '../../policy/index.ts'
import {
  askRule,
  Outcome,
  PermissionsPolicy,
  policyDenied,
  decisionOf,
  renderCommandDeny,
  Scope,
} from '../../policy/index.ts'
import { callOf } from '../../policy/decisions.ts'
import { redirectRuling } from '../../policy/match/decide.ts'
import { ioReach, ioRefusal, namingRules, notAllowed } from '../../policy/match/rule.ts'
import { commandRoute, settled } from '../../policy/policies.ts'
import { type CommandNode, CommandWord, type EntryGate } from '../../policy/types.ts'
import type { Encoded } from '../../rs/policy.ts'
import { encodeText } from '../../shell/bytes.ts'
import { getParts, getRedirects, getText, literalWord } from '../../shell/helpers.ts'
import type { Redirect, TSNodeLike } from '../../shell/types.ts'
import { NodeType, RedirectKind } from '../../shell/types.ts'
import { shellVoice } from '../../shell/voice.ts'
import { Follow, PathSpec, type LineFacts, type PolicyDecision } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { makeAbortError } from '../../utils/abort.ts'
import { getExtension } from '../../utils/filetype.ts'
import { pathVisible } from '../../utils/hidden.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { CondRefused } from '../executor/builtins/condition/errors.ts'
import { fileOperands, TEST_NAMES } from '../executor/builtins/condition/operands.ts'
import { followPaths } from '../executor/builtins/links/links.ts'
import { contextWords, linePaths, readLine } from '../executor/command/reading.ts'
import { reachesService } from '../executor/command/cli.ts'
import type { LineReading } from '../executor/command/types.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  mergeScopes,
  pathFlagScopes,
  routableScopes,
  routedOperands,
} from '../executor/command/routing.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import { specForCommand, specWordBases, specWordKinds } from '../expand/spec_hints.ts'
import { INTERPRETER_NAMES, WRITING_PROGRAMS } from '../lookup/constants.ts'
import { pathProgram } from '../lookup/lookup.ts'
import {
  Consumer,
  isTool,
  lineFacts,
  lookup,
  runsAs,
  SLASH_KEEPS_LAST,
  WordPolicy,
  wordPolicy,
} from '../lookup/index.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { wordValue, type Word } from './inner_lines.ts'
import { occurrenceOf } from './occurrence.ts'

/**
 * What the command plane prints when a line does not get to run: 126 for
 * a whole-command refusal or an unanswered ask, the operand code (1, tar
 * 2) for a refusal about a path or carrying an error. `decision` is the
 * record the result carries beside stderr, null for the filesystem's own
 * error. Mirrors the Python `Refused`.
 */
export interface Refused {
  readonly stderr: Uint8Array
  readonly exitCode: number
  readonly decision: PolicyDecision | null
}

function norm(virtual: string): string {
  return rstripSlash(virtual) || '/'
}

/**
 * The nodes a redirected statement may wrap whose last command is the
 * one the redirect binds to. A `!` wraps one command, so it is its own
 * last one: `! cat < f` parses as redirected(negated(cat), < f).
 */
const REDIRECT_CHAIN: ReadonlySet<string> = new Set([
  NodeType.LIST,
  NodeType.PIPELINE,
  NodeType.NEGATED_COMMAND,
])

/**
 * The nodes a redirect binds to as their own, judged with them: the
 * chain's last command, or the shell's test. Any other statement under a
 * redirect (a group, a loop, a subshell, an `if`, an assignment, or none)
 * leaves its redirect to `admitRedirect`.
 */
const REDIRECT_OWNERS: ReadonlySet<string> = new Set([NodeType.COMMAND, NodeType.TEST_COMMAND])

/** Whether a redirect names a file to open, not a body or a descriptor. */
function opensFile(r: Redirect): boolean {
  return (
    r.kind !== RedirectKind.HEREDOC &&
    r.kind !== RedirectKind.HERESTRING &&
    r.kind !== RedirectKind.AMBIGUOUS &&
    typeof r.target !== 'number' &&
    r.targetNode !== null
  )
}

/**
 * A command the gate let through, and what its own I/O may touch.
 *
 * The gate judged the paths the line names; a walk below them reaches
 * entries no rule has seen, so the dispatcher binds this to the session
 * context for the command's run and the commands tier asks it before each
 * read, write or listing (`EntryGate`). The paths the gate already judged
 * pass, since the line was admitted on them; every other entry is judged
 * by `ioRefusal` under the same precedence the gate applied to the line,
 * and a refusal is the dispatcher's `PolicyDenied` (EACCES, the path, the
 * reason on its record), which every command renders as GNU's
 * `Permission denied`.
 * `granted` holds the ask rules the line runs under a grant for: the one
 * the entry point answered for this line, and the session's standing ones.
 * `ctx` is what `preCommand` judged the command on, which `postCommand`
 * extends with what came back. `route` is where `preCommand` placed the
 * command over its line's placement; null when no policy placed it.
 */
export class Admitted implements EntryGate {
  readonly rules: AdmissionRules | null
  readonly ctx: CommandContext
  readonly judged: ReadonlySet<string>
  readonly granted: readonly CommandRule[]
  readonly route: Route | null
  private namedRules: Encoded | null | undefined = undefined

  constructor(init: {
    rules: AdmissionRules | null
    ctx: CommandContext
    judged: ReadonlySet<string>
    granted: readonly CommandRule[]
    route?: Route | null
  }) {
    this.rules = init.rules
    this.ctx = init.ctx
    this.judged = init.judged
    this.granted = init.granted
    this.route = init.route ?? null
  }

  // Throw `PolicyDenied` when a rule in force refuses this entry for the
  // running command.
  check(virtual: string): void {
    const reason = this.refusal(virtual)
    if (reason !== null) {
      throw policyDenied({ kind: 'deny', reason, policy: PermissionsPolicy.name }, virtual)
    }
  }

  // Whether anything at or under this path could be refused for the
  // running command: a rule in force at any path its scope could cover.
  // The dispatcher checks coded file policies separately.
  scopes(virtual: string): boolean {
    return this.rules !== null && ioReach(this.rules, this.named(), virtual, this.granted)
  }

  // The command's walk through the trees (`namingRules`), asked on the
  // first entry it reaches and kept for the rest of its run.
  named(): Encoded | null {
    if (this.namedRules === undefined) this.namedRules = namingRules(this.rules, this.ctx)
    return this.namedRules
  }

  // The reason a rule in force refuses this entry, null when the line was
  // admitted on it or nothing refuses it.
  refusal(virtual: string): string | null {
    if (this.judged.has(norm(virtual))) return null
    if (this.rules === null) return null
    return ioRefusal(this.rules, this.named(), virtual, this.granted)
  }
}

/**
 * The roots of the mounts below a walking command's paths, which its
 * fan-out enters with no admission of its own; empty for a command that
 * does not walk. Mirrors Python's `_walked_mounts`.
 */
function walkedMounts(
  walks: boolean,
  paths: readonly PathSpec[],
  registry: MountRegistry,
): string[] {
  if (!walks) return []
  const roots = new Set<string>()
  for (const path of paths)
    for (const entry of registry.descendantMounts(path.virtual))
      roots.add(rstripSlash(entry.prefix))
  return [...roots].sort(compareCodePoints)
}

/**
 * The paths of a line the session can see. A hidden path is nonexistent
 * for the session, so no policy may learn of it either: a rule scoped
 * to it must not fire (the reason would say the path is there), an ask
 * must not be raised for it (a request would name it to the host), and
 * the line runs on to the dispatcher, which answers ENOENT like any other
 * absent path. A path the reader could not read (`unread`, as `gate`
 * takes it) goes the same way, since the line may never name it.
 */
function seen(
  session: SessionState,
  specs: readonly PathSpec[],
  unread: ReadonlySet<string> = new Set(),
): PathSpec[] {
  return specs.filter((p) => !unread.has(p.virtual) && pathVisible(session.visibility, p.virtual))
}

/**
 * The words a policy is shown, a path `seen` drops taken off the word that
 * names it, so a policy reads the word and never the path. Mirrors Python's
 * `_seen_words`.
 */
function seenWords(
  session: SessionState,
  words: readonly CommandWord[],
  unread: ReadonlySet<string>,
): CommandWord[] {
  const shown = new Set(
    seen(
      session,
      words.flatMap((w) => (w.path !== null ? [w.path] : [])),
      unread,
    ).map((p) => p.virtual),
  )
  return words.map((w) =>
    w.path === null || shown.has(w.path.virtual)
      ? w
      : new CommandWord(w.text, w.kind, w.option, null),
  )
}

/**
 * The command plane's admission of one command: the policy chain, then
 * the approval ledger. The one gate every command class passes through,
 * in the tree (`runArgv`, once the words are expanded) and for a line a
 * runtime takes whole (`admitLine`, per parsed command). A word a
 * closed tree names nothing for is the profile's Deny, like any other
 * leaf's; a path the session cannot see is
 * dropped before any method, so a rule never names it and the dispatcher
 * answers ENOENT; a Deny renders in the outcome table's voice; an Ask
 * is answered by the entry point from the session's grants or the host.
 * `stdin` decides whether a bare `rg` reads the working directory.
 */
/**
 * One command's literal words, classified the way the runtime would
 * classify them, so the gate and the run name the same paths.
 */
export async function classifiedWords(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): Promise<(string | PathSpec)[]> {
  const line = [name, ...args]
  const [wordKinds, wordBases] = wordHints(line, session, registry)
  return await classifyParts(line, registry, session.cwd, wordKinds, wordBases)
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
 * spent on it: the classified context, and the policy chain's answer (the
 * first Deny, else the first Ask) with the answers it came from.
 *
 * Split out of `admit` so a dry run can have the answer without the
 * consequences. Nothing here records a request, consumes a grant or
 * reaches the host, which is what makes it safe for `explain`;
 * `admit` adds exactly those and renders.
 *
 * `intrinsic` keeps shell-provided operations subject to a tree's root
 * even when a function shadows their policy name. `unread` holds the
 * virtual paths a reader of the line's text cannot vouch for: what a word
 * only the runtime expands names, or a relative word after a `cd` it
 * could not follow. No policy is shown them; the per-command gate reads
 * the real ones and passes none. `every` asks every policy past a Deny,
 * for `explain`; the gate's own answers end at the first Deny.
 * `rulesOnly` asks the profile's rules alone, for a pass that judges a line
 * before it runs; a policy's own `preCommand` is asked once, by the gate
 * that runs the command. `line` is the line the command was parsed from,
 * empty outside a line.
 */
/**
 * Whether the profile leaves out a CLI that reaches a service. Such a CLI
 * (an account or script CLI) reaches its service by id, past every hide, so
 * under a profile that hides paths it runs only where the profile's
 * top-level tree names it at its root with an allow somewhere in that
 * node. `*` does not count, and neither does inline permissions' tree,
 * which only tightens. What the node says of the line is the tree's to
 * judge, so what is left here is whether the profile names the command at
 * all. Mirrors the Python `unlisted_service`.
 */
export function unlistedService(
  ctx: CommandContext,
  registry: MountRegistry,
  session: SessionState,
): boolean {
  const install = registry.clis.get(ctx.command)
  if (
    ctx.tool === false ||
    install === null ||
    !reachesService(install.cli) ||
    session.visibility.paths === null
  ) {
    return false
  }
  const rules = session.commands
  return !rules?.trees.some((scoped) => {
    const node =
      scoped.mount || scoped.inline ? undefined : scoped.tree.subcommands.get(ctx.command)
    return node !== undefined && yieldsAllow(node)
  })
}

function yieldsAllow(node: CommandNode): boolean {
  return (
    node.decision?.decision === Outcome.ALLOW ||
    [...node.subcommands.values()].some(yieldsAllow) ||
    [...node.operands.values()].some(yieldsAllow)
  )
}

/**
 * Whether a command tree's leaf the line reaches may change state, read off
 * the line's own reading when that reading is this tree's, else off a walk
 * under the session environment. Mirrors the tree branch of Python's
 * `_writes`.
 */
function treeWrites(
  name: string,
  cli: CLI,
  args: readonly string[],
  reading: LineReading,
  session: SessionState,
): boolean {
  if (reading.read !== null && reading.grammar?.spec === cli.spec) {
    const options = reading.read.flags.map((flag) => flag.name)
    return cli.handlers[reading.program.slice(1).join(' ')]?.writes(options) === true
  }
  const env = envSnapshot(session)
  const result = walk(name, cli.spec, [...args], session.cwd, env)
  return (
    result.leaf !== null &&
    cli.handlers[result.path.join(' ')]?.writes(leafOptions(cli, result, session.cwd, env)) === true
  )
}

/**
 * Whether the handler a command resolves to declares that it may change
 * state. A command tree's leaf (an installed CLI's, or a tree a mount
 * serves) as its walk names it, under the session environment its run walks
 * with, which fills a group option declaring `Argument.env`; any other mount
 * command as every handler a run of it may reach: on the mount that would run
 * it (the mount of the first path the line names, else of the working
 * directory), on each path's own mount, which a run across mounts hands that
 * path, and on every mount below a path, which a walk reaches. Its handler is
 * picked by an operand's extension, so each path's counts, and a run follows
 * links before it picks either, so a link's target counts beside its name.
 * Mirage's own handler counts only when the line's options let it write
 * (`LineFacts.writes`: `sort -o` writes, `sort` does not). A namespace or
 * routed program that changes what it names (`WRITING_PROGRAMS`: `ln`,
 * `chmod` ...) writes by name. A walk the tree refuses runs nothing, and a
 * shell builtin, a function, an external program or an unknown name declares
 * nothing. Mirrors Python's `_writes`.
 */
function writes(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  reading: LineReading,
  facts: LineFacts,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  implied: PathSpec | null,
): boolean {
  const consumer = lookup(name, session, registry)
  if (
    WRITING_PROGRAMS.has(name) &&
    (consumer === Consumer.NAMESPACE || consumer === Consumer.MOUNT)
  )
    return true
  if (consumer !== Consumer.CLI && consumer !== Consumer.MOUNT) return false
  const tree = registry.clis.get(name)?.cli ?? null
  if (tree !== null) return treeWrites(name, tree, args, reading, session)
  const candidates = registry.invocationCandidates(
    name,
    [],
    session.cwd,
    args,
    sessionAccess(session),
  )
  if ((candidates[0]?.cliFor(name) ?? null) !== null) {
    return candidates.some((mount) => {
      const cli = mount.cliFor(name)
      if (cli === null) return mount.mayWrite(name)
      return treeWrites(name, cli, args, reading, session)
    })
  }
  const runs = runsAs(name, registry)
  // The words that route the run, picked as execution picks them: a stdin `-`
  // and an assignment route nowhere, and a path-valued option, attached or
  // not, routes like an operand.
  const named = mergeScopes(
    routableScopes(
      runs,
      routedOperands(
        runs,
        [...args],
        session.cwd,
        operands,
        operands.filter((p): p is PathSpec => p instanceof PathSpec),
      ),
    ),
    pathFlagScopes(runs, [...args], session.cwd),
  ).filter((s) => s.walkError !== 'ENOENT')
  if (namespace !== null && namespace.nodes.size > 0 && named.length > 0) {
    const typed = new Set(named.map((p) => p.virtual))
    const followed = followPaths(
      namespace.sessionLinks(session),
      [...named],
      facts.follows !== Follow.NONE,
      !SLASH_KEEPS_LAST.has(name),
    )
    for (const p of followed) {
      if (p instanceof PathSpec && !typed.has(p.virtual)) named.push(p)
    }
  }
  const scopes = named.length > 0 ? named : implied !== null ? [implied] : []
  const reached = registry.invocationCandidates(
    runs,
    scopes.slice(0, 1),
    session.cwd,
    args,
    sessionAccess(session),
  )
  for (const scope of scopes) {
    const owner = registry.tryMountFor(scope.virtual)
    const below = `${rstripSlash(scope.virtual)}/`
    for (const item of registry
      .allMounts()
      .filter((m) => m === owner || m.prefix.startsWith(below)))
      reached.push(item)
  }
  const extensions = named.length > 0 ? new Set(named.map((p) => getExtension(p.virtual))) : [null]
  return reached.some((mount) => {
    const cli = mount.cliFor(runs)
    if (cli !== null) return treeWrites(runs, cli, args, reading, session)
    return [...extensions].some((extension) => mount.mayWrite(runs, extension, facts.writes))
  })
}

/**
 * The name a path-spelled command's program is judged by too: a machine execs
 * the path, so a rule or a coded check naming the program speaks for it there.
 * Null for a word with no slash, and for a `/usr/bin` path Mirage runs as its
 * program by name (`pathProgram`), judged by that name when it is dispatched.
 */
function programNamed(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
): string | null {
  if (!name.includes('/')) return null
  const base = name.slice(name.lastIndexOf('/') + 1)
  const links = namespace === null ? null : namespace.sessionLinks(session)
  if (base === '' || pathProgram(name, session, registry, links) !== null) return null
  return base
}

export async function gate(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  stdin: ByteSource | null = null,
  redirects: readonly PathSpec[] = [],
  intrinsic = false,
  unread: ReadonlySet<string> = new Set(),
  every = false,
  rulesOnly = false,
  line = '',
): Promise<[CommandContext, Deny | Ask | null, (Deny | Ask | Route)[]]> {
  const tool = intrinsic || isTool(name, session, registry)
  const env = envSnapshot(session)
  const reading = readLine(registry, name, args, operands, session.cwd, env, sessionAccess(session))
  const implied =
    name in CWD_DEFAULT_RAW
      ? defaultCwdOperand([name, ...operands], name, registry, session.cwd, stdin)
      : null
  // Each read of the words is a pass over all of them, so a command of a
  // million words yields between them: a cancel or the line's deadline
  // lands before the policies are asked.
  const budget = new YieldBudget(callerSignal())
  await budget.run()
  const facts = lineFacts(name, [name, ...operands], session.cwd)
  const follows = facts.follows !== Follow.NONE
  const links =
    namespace !== null && namespace.nodes.size > 0 ? namespace.sessionLinks(session) : null
  const paths = seen(
    session,
    linePaths(name, reading, follows, links, session.cwd, implied, redirects),
    unread,
  )
  const words = seenWords(session, contextWords(name, reading, redirects), unread)
  await budget.run()
  const write = writes(name, args, operands, reading, facts, session, registry, namespace, implied)
  await budget.run()
  const ctx: CommandContext = {
    line,
    command: name,
    paths,
    words,
    argv: [...args],
    cwd: session.cwd,
    sessionId: session.sessionId,
    tokens: [...reading.tokens],
    program: [...reading.program],
    read: reading.read,
    tool,
    walks: facts.walks,
    walksInto: walkedMounts(facts.walks, paths, registry),
    write,
    subtree: facts.subtree,
    moveTarget: facts.moveTarget,
    // The methods read the session this command is judged in, which for a
    // line explain walks is the walked one, not the stored one.
    ...registry.policies.views?.(session.sessionId, session),
  }
  const answers = [...(await registry.policies.answers('preCommand', ctx, every, rulesOnly))]
  const named = programNamed(name, session, registry, namespace)
  if (named !== null) {
    // Only a named entry speaks (no tree root), so a name grants nothing; the
    // path's run is placed by its own words, so a route of the name does not
    // move it.
    // Its words are classified by the program's own grammar.
    const classified = (await classifiedWords(named, args, session, registry)).slice(1)
    const own = readLine(
      registry,
      named,
      args,
      classified,
      session.cwd,
      env,
      sessionAccess(session),
    )
    const ownImplied =
      named in CWD_DEFAULT_RAW
        ? defaultCwdOperand([named, ...classified], named, registry, session.cwd, stdin)
        : null
    const ownFacts = lineFacts(named, [named, ...classified], session.cwd)
    const ownPaths = seen(
      session,
      linePaths(
        named,
        own,
        // The path's program never reaches Mirage's own link resolution, so
        // it follows links as the path does.
        follows,
        links,
        session.cwd,
        ownImplied,
        redirects,
      ),
      unread,
    )
    const programCtx: CommandContext = {
      ...ctx,
      command: named,
      tool: false,
      tokens: [...own.tokens],
      program: [...own.program],
      read: own.read,
      walks: ownFacts.walks,
      walksInto: walkedMounts(ownFacts.walks, ownPaths, registry),
      write: writes(
        named,
        args,
        classified,
        own,
        ownFacts,
        session,
        registry,
        namespace,
        ownImplied,
      ),
      subtree: ownFacts.subtree,
      moveTarget: ownFacts.moveTarget,
      paths: ownPaths,
      words: seenWords(session, contextWords(named, own, redirects), unread),
    }
    const byName = await registry.policies.answers('preCommand', programCtx, every, rulesOnly)
    answers.push(...byName.filter((a) => a.kind === 'deny' || a.kind === 'ask'))
  }
  if (unlistedService(ctx, registry, session)) {
    answers.unshift({
      kind: 'deny',
      reason: notAllowed(reading.program),
      policy: PermissionsPolicy.name,
    })
  }
  const verdict = settled(answers)
  return [ctx, verdict?.kind === 'route' ? null : verdict, answers]
}

/**
 * The chain's answer once the ledger has had its say. An Ask is the chain's
 * answer only after every Deny had its say; the ledger answers it from the
 * session's records or the host, so an answer never re-opens a deny. A wait
 * the run's kill cut short is the kill landing late, not a ruling, so it
 * throws as every other abandoned wait does rather than being rendered as a
 * refusal the document never made. Mirrors the Python `resolved`.
 */
export async function resolved(
  ctx: CommandContext,
  asked: Deny | Ask | null,
  registry: MountRegistry,
  signal: AbortSignal | undefined,
  claimant: Claimant | null,
): Promise<Deny | Pending | null> {
  if (asked?.kind !== 'ask') return asked
  const action = await registry.decisions.resolve(ctx, asked, signal, claimant)
  if (action !== null && action.kind === 'abandoned') throw makeAbortError()
  return action
}

export async function admit(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
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
  // Shell-provided operations keep their tool policy even if a function shadows the name.
  intrinsic = false,
  // Paths no policy is shown, as `gate` takes them.
  unread: ReadonlySet<string> = new Set(),
  // Ask the profile's rules alone, as `gate` takes it.
  rulesOnly = false,
): Promise<Refused | Admitted> {
  const gated = await gate(
    name,
    args,
    operands,
    session,
    registry,
    namespace,
    stdin,
    redirects,
    intrinsic,
    unread,
    false,
    rulesOnly,
    claimant?.occurrence.source ?? '',
  )
  const [ctx, asked, answers] = gated
  const action = await resolved(ctx, asked, registry, signal, claimant)
  if (action === null) {
    const granted = session.decisions
      .filter((r) => r.scope === Scope.SESSION && r.outcome === Outcome.ALLOW)
      .map((r) => r.rule)
    if (asked !== null && asked.kind === 'ask')
      granted.unshift(...(asked.rules ?? [askRule(ctx, asked)]))
    return new Admitted({
      rules: session.commands,
      ctx,
      judged: new Set(ctx.paths.map((p) => norm(p.virtual))),
      granted,
      route: commandRoute(answers),
    })
  }
  const [stderr, exitCode] = await renderCommandDeny(name, action, ctx)
  return { stderr, exitCode, decision: decisionOf(action) }
}

/**
 * Admit a `[ ]` test, or one `[[ ]]` leaf, as the command it is: the shell
 * evaluates it itself, so no command gate saw its words, and a tree or a
 * policy answers it by its own name as it answers `test` on the same
 * words. `name` is `[` or `[[`; `words` what it tests, expanded,
 * operators included; `signal` the run's abort signal; `claimant` the test
 * and its line, null outside a line. Throws `CondRefused` where the gate
 * refused it. Mirrors Python's admit_test.
 */
export async function admitTest(
  name: string,
  words: string[],
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  signal?: AbortSignal,
  claimant: Claimant | null = null,
): Promise<Admitted> {
  const classified = await classifiedWords(name, words, session, registry)
  const verdict = await admit(
    name,
    words,
    classified.slice(1),
    session,
    registry,
    namespace,
    null,
    [],
    signal,
    claimant,
    true,
  )
  if (!(verdict instanceof Admitted)) {
    throw new CondRefused(verdict.stderr, verdict.exitCode, verdict.decision)
  }
  return verdict
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
  session: SessionState,
  registry: MountRegistry,
): [(ValueType | null)[] | null, (string | null)[] | null] {
  const consumed = registry.matchCommandPrefix([...line])
  const joined = line.slice(0, consumed).join(' ')
  if (TEST_NAMES.has(joined)) return [fileOperands(joined, line.slice(1)), null]
  const consumer = lookup(joined, session, registry)
  // A mount command's spec is read, and so is a native capture's and an
  // interpreter's: `python3 steal.py` runs on the runtime's own disk or
  // a host process, where no dispatcher follows the read, so the script
  // slot the spec declares is the one place a path rule can see the
  // file. The tree's gate reads a native capture the same way
  // (`expandArgv`), and an interpreter it runs itself for the script slot
  // alone, since its other words become the program's argv there; here
  // the hints reach no runtime word, since the line runs as typed, so
  // there is nothing to lose by reading them all.
  if (
    consumer === Consumer.FUNCTION ||
    !(
      wordPolicy(consumer) === WordPolicy.MOUNT ||
      consumer === Consumer.EXTERNAL ||
      INTERPRETER_NAMES.has(joined)
    )
  ) {
    return [null, null]
  }
  // A wrapper's words are the program's it runs.
  const runs = runsAs(joined, registry)
  const spec = specForCommand(
    runs,
    registry,
    session.cwd,
    line.slice(consumed),
    sessionAccess(session),
  )
  if (spec === null) return [null, null]
  const extra: (ValueType | null)[] = new Array<ValueType | null>(consumed - 1).fill('str')
  const wordKinds = [
    ...extra,
    ...specWordKinds(spec, [...line.slice(consumed)], runs, envSnapshot(session)),
  ]
  const bases = specWordBases(
    spec,
    [...line.slice(consumed)],
    session.cwd,
    runs,
    envSnapshot(session),
  )
  const wordBases =
    bases === null ? null : [...new Array<string | null>(consumed - 1).fill(null), ...bases]
  return [wordKinds, wordBases]
}

/**
 * Whether a redirected statement's command is a bare `exec`, which installs
 * its redirects on the shell for every later statement; `exec cmd` is a
 * command. Mirrors Python's is_bare_exec.
 */
export function isBareExec(command: TSNodeLike | null): boolean {
  if (command?.type !== NodeType.COMMAND) return false
  const named = getParts(command)
  return (
    named.length === 1 && named[0]?.type === NodeType.COMMAND_NAME && getText(named[0]) === 'exec'
  )
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
 * the last-command chain instead, which is bash's own rule for a list,
 * a pipeline and a `!`. A compound (`{ }`, a loop, a subshell) redirects
 * every command inside it, which is not a chain, so none is claimed
 * here: `admitRedirect` judges it as the shell opens it, and
 * `unownedRedirects` reads it for a line a runtime takes whole. A bare
 * `exec` (`exec 3< f`) has none: it installs them on the shell, and
 * `admitRedirect` judges each as it opens.
 */
function statementRedirectsRaw(node: TSNodeLike): Redirect[] {
  return isBareExec(node) ? [] : boundRedirects(node)
}

/**
 * The redirects bound to a node along the last-command chain, as bash
 * binds them: `a && { b; } < f` opens `f` for the group, after `a` ran.
 * Mirrors the Python `_bound_redirects`.
 */
function boundRedirects(node: TSNodeLike): Redirect[] {
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
  return redirects
}

/**
 * The literal targets of the redirects no command owns that the shell
 * opens as it reaches `node`: a bare statement's (`> f`), or a group's, a
 * loop's, a subshell's, an `if`'s, an assignment's or a bare `exec`'s,
 * bound along the last-command chain. Empty for a command that owns its
 * redirects (`statementRedirects`) and for any node no redirect binds to.
 * Mirrors the Python `opened_by`.
 */
export function openedBy(node: TSNodeLike, homes: Readonly<Record<string, string>> | null): Word[] {
  let redirects: Redirect[]
  if (node.type === NodeType.REDIRECTED_STATEMENT) {
    const [inner, own] = getRedirects(node)
    if (inner !== null) return []
    redirects = own
  } else if (
    REDIRECT_CHAIN.has(node.type) ||
    (REDIRECT_OWNERS.has(node.type) && !isBareExec(node))
  ) {
    return []
  } else {
    redirects = boundRedirects(node)
  }
  return redirects
    .filter(opensFile)
    .map((r) => ({ raw: String(r.target), text: literalWord(r.targetNode as TSNodeLike, homes) }))
}

/** Mark redirected input without opening or expanding its source. */
export function statementStdin(node: TSNodeLike): Uint8Array | null {
  return statementRedirectsRaw(node).some((r) => r.fd === 0) ? new Uint8Array(0) : null
}

export function statementRedirects(
  node: TSNodeLike,
  homes: Readonly<Record<string, string>> | null,
): Word[] {
  return statementRedirectsRaw(node)
    .filter(opensFile)
    .map((r) => ({ raw: String(r.target), text: literalWord(r.targetNode as TSNodeLike, homes) }))
}

/**
 * The literal target of every redirect in a parsed line that no command
 * owns, with the target's node: a compound statement's, a bare one's, a
 * bare `exec`'s, an assignment's. A command's own redirects are its words
 * (`statementRedirects`); these are read for a line a runtime takes whole,
 * where no executor opens them. Mirrors Python's unowned_redirects.
 */
export function unownedRedirects(
  node: TSNodeLike,
  homes: Readonly<Record<string, string>> | null,
): [Word, TSNodeLike][] {
  const out: [Word, TSNodeLike][] = []
  const stack: TSNodeLike[] = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    stack.push(...[...current.namedChildren].reverse())
    if (current.type !== NodeType.REDIRECTED_STATEMENT) continue
    const [inner, redirects] = getRedirects(current)
    let owner: TSNodeLike | null = inner
    while (owner !== null && REDIRECT_CHAIN.has(owner.type)) {
      owner = owner.namedChildren[owner.namedChildren.length - 1] ?? null
    }
    if (owner !== null && REDIRECT_OWNERS.has(owner.type) && !isBareExec(owner)) continue
    for (const r of redirects.filter(opensFile)) {
      const at = r.targetNode as TSNodeLike
      out.push([{ raw: String(r.target), text: literalWord(at, homes) }, at])
    }
  }
  return out
}

/**
 * What the session's trees answer about a redirect no command owns when
 * they do not simply let it open: the question the ledger reads a grant
 * against, the trees' answer and the path the rule named. Mirrors
 * Python's RedirectAsked.
 */
export interface RedirectAsked {
  readonly question: CommandContext
  readonly answer: Deny | Ask
  readonly named: string
}

/**
 * The trees' answer about the files a redirect no command owns opens,
 * read without asking anyone: the half of `admitRedirect` the dry run
 * shares. Null when they let it open. Mirrors Python's redirect_asked.
 */
export function redirectAsked(
  targets: readonly PathSpec[],
  session: SessionState,
  namespace: Namespace | null,
): RedirectAsked | null {
  const rules = session.commands
  if (rules === null || targets.length === 0) return null
  const links =
    namespace !== null && namespace.nodes.size > 0 ? namespace.sessionLinks(session) : null
  const paths = [...targets]
  if (links !== null) {
    for (const p of followPaths(links, [...targets], true)) if (p instanceof PathSpec) paths.push(p)
  }
  const shown = seen(session, paths)
  const ruling = redirectRuling(shown, rules)
  if (ruling.outcome === Outcome.ALLOW) return null
  const rule = ruling.rule
  if (rule === null) throw new Error('a tree refused a redirect with no leaf')
  const named = ruling.matchedPath ?? shown[0]?.virtual ?? ''
  const question: CommandContext = {
    command: '',
    paths: shown,
    argv: shown.map((p) => p.virtual),
    cwd: session.cwd,
    sessionId: session.sessionId,
  }
  const answer: Deny | Ask =
    ruling.outcome === Outcome.ASK
      ? {
          kind: 'ask',
          reason: ruling.reason,
          rule,
          rules: ruling.asks,
          policy: PermissionsPolicy.name,
        }
      : {
          kind: 'deny',
          reason: ruling.reason,
          path: named,
          policy: PermissionsPolicy.name,
          rule,
        }
  return { question, answer, named }
}

/**
 * A redirect's refusal in bash's voice for a file it could not open
 * (`bash: line 1: f: Permission denied`, exit 1), the decision on the
 * result. Mirrors Python's redirect_refused.
 */
export function redirectRefused(
  targets: readonly PathSpec[],
  named: string,
  action: Deny | Pending,
  voice: string,
): Refused {
  const target = targets.find((p) => p.virtual === named) ?? targets[0]
  const raw = target?.rawPath ?? named
  return {
    stderr: encodeText(`${voice}${raw}: Permission denied\n`),
    exitCode: 1,
    decision: decisionOf(action),
  }
}

/**
 * The gate of the files a redirect opens that no command owns: a
 * compound statement's (`{ cat; } < f`, a loop, a subshell, an `if`) or
 * a bare one (`> f`, `exec 3< f`). A command's own redirects are judged
 * with the command; these have no command, so the session's trees alone
 * are asked, and only the root leaf of a folder entry holding a path the
 * redirect opens speaks (`redirectRuling`). A coded policy is not asked:
 * it judges the open itself, at the dispatcher. A hidden target is dropped first, so
 * the open answers ENOENT; links are followed as a command's redirect
 * targets are. A deny, or an ask the host did not grant, refuses in
 * bash's voice for a redirect it could not open (`bash: line 1: f:
 * Permission denied`, exit 1), with the decision on the result. An ask is
 * claimed for the place the redirect stands on its line (`at`, the target
 * word of the redirect that opens them; null for targets no one redirect
 * opens, a line judged whole), so each open is a nod of its own, as each
 * command is. Mirrors Python's admit_redirect.
 */
export async function admitRedirect(
  targets: readonly PathSpec[],
  session: SessionState,
  registry: MountRegistry,
  namespace: Namespace | null,
  at: TSNodeLike | null = null,
): Promise<Refused | null> {
  const asked = redirectAsked(targets, session, namespace)
  if (asked === null) return null
  const answer = asked.answer
  let action: Deny | Pending | null
  if (answer.kind === 'ask') {
    const caller = currentCaller()
    const call = callOf(caller, registry.decisions, session.sessionId)
    const claimant: Claimant | null =
      call === null
        ? null
        : {
            line: call,
            occurrence:
              at === null
                ? { parent: null, source: asked.named, start: 0, end: 0 }
                : occurrenceOf(at, call),
          }
    action = await resolved(asked.question, answer, registry, callerSignal(), claimant)
    if (action === null) return null
  } else {
    action = answer
  }
  return redirectRefused(targets, asked.named, action, shellVoice())
}

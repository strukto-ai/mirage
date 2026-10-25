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

import { pathVisible } from '../../utils/hidden.ts'
import { sessionAccess } from '../../context/session_context.ts'
import type { ByteSource } from '../../io/types.ts'
import {
  Outcome,
  PermissionsPolicy,
  Scope,
  askRule,
  policyDenied,
  refusalOf,
  renderDeny,
} from '../../policy/index.ts'
import type {
  Ask,
  Claimant,
  CommandContext,
  CommandRule,
  AdmissionRules,
  Deny,
  Pending,
} from '../../policy/index.ts'
import { settled } from '../../policy/policies.ts'
import { ioReach, ioRefusal } from '../../policy/match/rule.ts'
import { lineTokens } from '../../policy/match/allow.ts'
import { patternMatches, splitPattern } from '../../policy/match/pattern.ts'
import type { ValueType } from '../../commands/spec/types.ts'
import { getRedirects, literalWord } from '../../shell/helpers.ts'
import { NodeType, RedirectKind } from '../../shell/types.ts'
import type { Redirect, TSNodeLike } from '../../shell/types.ts'
import { PathSpec, type Refusal } from '../../types.ts'
import type { NamespaceLinks } from '../../view/types.ts'
import { CommandWord, type EntryGate } from '../../policy/types.ts'
import { resolvePath } from '../../utils/path.ts'
import { getExtension } from '../../utils/filetype.ts'
import { makeAbortError } from '../../utils/abort.ts'
import { toScope } from '../executor/builtins/scope.ts'
import { followPaths } from '../executor/builtins/links/links.ts'
import { TEST_NAMES, fileOperands } from '../executor/builtins/condition/operands.ts'
import { CondRefused } from '../executor/builtins/condition/types.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  mergeScopes,
  pathFlagScopes,
  routableScopes,
  routedOperands,
  commandWords,
  programTokens,
  treePathScopes,
} from '../executor/command/routing.ts'
import { reachesService } from '../executor/command/cli.ts'
import { walk } from '../../commands/cli/walk.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { classifyBarePath } from '../expand/classify/path.ts'
import { specForCommand, specWordBases, specWordKinds } from '../expand/spec_hints.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { INTERPRETER_NAMES, WRITING_PROGRAMS } from '../lookup/constants.ts'
import {
  Consumer,
  SLASH_KEEPS_LAST,
  WordPolicy,
  changesFiles,
  followsLastComponent,
  isTool,
  lineFlags,
  lookup,
  runsAs,
  walksMounts,
  wordPolicy,
} from '../lookup/index.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { wordValue, type Word } from './inner_lines.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * What the command plane prints when a line does not get to run: 126 for
 * a whole-command refusal or an unanswered ask, the operand code (1, tar
 * 2) for a refusal about a path or carrying an error. `refusal` is the
 * record the result carries beside stderr, null for the filesystem's own
 * error. Mirrors the Python `Refused`.
 */
export interface Refused {
  readonly stderr: Uint8Array
  readonly exitCode: number
  readonly refusal: Refusal | null
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
 * extends with what came back.
 */
export class Admitted implements EntryGate {
  readonly rules: AdmissionRules | null
  readonly ctx: CommandContext
  readonly judged: ReadonlySet<string>
  readonly granted: readonly CommandRule[]

  constructor(init: {
    rules: AdmissionRules | null
    ctx: CommandContext
    judged: ReadonlySet<string>
    granted: readonly CommandRule[]
  }) {
    this.rules = init.rules
    this.ctx = init.ctx
    this.judged = init.judged
    this.granted = init.granted
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
    return ioReach(this.rules, this.ctx.tokens ?? [], virtual)
  }

  // The reason a rule in force refuses this entry, null when the line was
  // admitted on it or nothing refuses it.
  refusal(virtual: string): string | null {
    if (this.judged.has(norm(virtual))) return null
    return ioRefusal(this.rules, this.ctx.tokens ?? [], virtual, this.granted)
  }
}

/**
 * The paths a path-pattern guard reads for a line: the operands as
 * typed and the values of path-valued flags, a command tree's group and
 * leaf options among them (`treeFlags`, from `treePathScopes`), then, for
 * a command that
 * follows links, the targets they resolve to. `cat /data/link` reads
 * `/data/secret`, so a rule protecting the target has to see it, and a
 * command-scoped rule never runs at the dispatcher where the resolved path
 * would otherwise be checked. The links are followed as the command's own
 * session sees them (`links`, `Namespace.sessionLinks`), as the router
 * follows them: on the browser fallback the ambient view folds every live
 * session's hides, and a peer hiding the link must not keep its target from
 * the rule; null where no link stands. The follow policy is the command's own
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
  links: NamespaceLinks | null,
  cwd: string,
  implied: PathSpec | null = null,
  redirects: readonly PathSpec[] = [],
  treeFlags: readonly PathSpec[] = [],
): PathSpec[] {
  const scopes: PathSpec[] = []
  for (const p of operands) {
    if (p instanceof PathSpec) scopes.push(p)
  }
  scopes.push(...pathFlagScopes(name, [...args], cwd))
  const typed = new Set(scopes.map((p) => p.virtual))
  scopes.push(...treeFlags.filter((p) => !typed.has(p.virtual)))
  if (name.includes('/')) {
    // A slash-carrying head word is a file the line executes, and it
    // lives in argv[0], not the operands, so a path-pattern guard would
    // never see it without this row.
    scopes.unshift(toScope(resolvePath(name, cwd)))
  }
  if (links !== null && operands.length > 0) {
    const followed = followPaths(
      links,
      [...operands],
      followsLastComponent(name, [name, ...args]),
      !SLASH_KEEPS_LAST.has(name),
    )
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
    if (links !== null) {
      const followed = followPaths(links, [...redirects], true, true)
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
 * runtime takes whole (`admitLine`, per parsed command). A word the
 * session's allow list leaves out is the profile's Deny, like any other
 * rule's; a path the session cannot see is
 * dropped before any method, so a rule never names it and the dispatcher
 * answers ENOENT; a Deny renders in the outcome table's voice; an Ask
 * is answered by the entry point from the session's grants or the host.
 * `stdin` decides whether a bare `rg` reads the working directory.
 */
/**
 * One command's literal words, classified the way the runtime would
 * classify them, so the gate and the run name the same paths.
 */
export function classifiedWords(
  name: string,
  args: readonly string[],
  session: SessionState,
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
 * spent on it: the classified context, and the policy chain's answer (the
 * first Deny, else the first Ask) with the answers it came from.
 *
 * Split out of `admit` so a dry run can have the answer without the
 * consequences. Nothing here records a request, consumes a grant or
 * reaches the host, which is what makes it safe for `explain`;
 * `admit` adds exactly those and renders.
 *
 * `intrinsic` keeps shell-provided operations subject to tool allow lists
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
 * Whether the allow list refuses a CLI that reaches a service. Such a CLI
 * (an account or script CLI) reaches its service by id, past every hide, so
 * under a profile that hides paths it runs only where a pattern starting
 * with its own name matches the line. `*` and a pattern for another of its
 * verbs do not count. Mirrors the Python `unlisted_service`.
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
  const tokens = lineTokens(ctx)
  return !(session.commands?.allow ?? []).some(
    (p) => splitPattern(p)[0] === ctx.command && patternMatches(p, tokens),
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
 * (`changesFiles`: `sort -o` writes, `sort` does not). A namespace or
 * routed program that changes what it names (`WRITING_PROGRAMS`: `ln`,
 * `chmod` ...) writes by name. A walk the tree refuses runs nothing, and a
 * shell builtin, a function, an external program or an unknown name declares
 * nothing. Mirrors Python's `_writes`.
 */
function writes(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
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
  if (tree !== null) {
    const result = walk(name, tree.spec, [...args], session.cwd, envSnapshot(session))
    return result.leaf !== null && tree.handlers[result.path.join(' ')]?.write === true
  }
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
      const result = walk(name, cli.spec, args, session.cwd, envSnapshot(session))
      return result.leaf !== null && cli.handlers[result.path.join(' ')]?.write === true
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
      followsLastComponent(name, [name, ...args]),
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
    reached.push(...registry.allMounts().filter((m) => m === owner || m.prefix.startsWith(below)))
  }
  const extensions = named.length > 0 ? new Set(named.map((p) => getExtension(p.virtual))) : [null]
  const builtins = changesFiles(runs, [runs, ...operands])
  return reached.some((mount) => {
    const cli = mount.cliFor(runs)
    if (cli !== null) {
      const result = walk(runs, cli.spec, args, session.cwd, envSnapshot(session))
      return result.leaf !== null && cli.handlers[result.path.join(' ')]?.write === true
    }
    return [...extensions].some((extension) => mount.mayWrite(runs, extension, builtins))
  })
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
): Promise<[CommandContext, Deny | Ask | null, (Deny | Ask)[]]> {
  const tool = intrinsic || isTool(name, session)
  const env = envSnapshot(session)
  const [tokens, program] = programTokens(
    registry,
    name,
    [...args],
    session.cwd,
    env,
    sessionAccess(session),
  )
  const implied =
    name in CWD_DEFAULT_RAW
      ? defaultCwdOperand([name, ...operands], name, registry, session.cwd, stdin)
      : null
  const ctx: CommandContext = {
    line,
    command: name,
    paths: seen(
      session,
      policyScopes(
        name,
        args,
        operands,
        namespace !== null && namespace.nodes.size > 0 ? namespace.sessionLinks(session) : null,
        session.cwd,
        implied,
        redirects,
        treePathScopes(registry, name, args, session.cwd, env, sessionAccess(session)),
      ),
      unread,
    ),
    words: seenWords(
      session,
      commandWords(
        registry,
        name,
        args,
        operands,
        redirects,
        session.cwd,
        env,
        sessionAccess(session),
      ),
      unread,
    ),
    argv: [...args],
    cwd: session.cwd,
    sessionId: session.sessionId,
    tokens,
    program,
    tool,
    walks: walksMounts(name, lineFlags(name, [name, ...args])),
    write: writes(name, args, operands, session, registry, namespace, implied),
    // The methods read the session this command is judged in, which for a
    // line explain walks is the walked one, not the stored one.
    ...(rulesOnly ? null : registry.policies.views?.(session.sessionId, session)),
  }
  const answers = (await registry.policies.answers('preCommand', ctx, every, rulesOnly)).filter(
    (a): a is Deny | Ask => a.kind !== 'route',
  )
  if (unlistedService(ctx, registry, session)) {
    answers.unshift({
      kind: 'deny',
      reason: `${program.join(' ')} is not allowed`,
      policy: PermissionsPolicy.name,
    })
  }
  return [ctx, settled(answers), answers]
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
  const [ctx, asked] = gated
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
    })
  }
  const [stderr, exitCode] = renderDeny(name, action)
  return { stderr, exitCode, refusal: refusalOf(action) }
}

/**
 * Admit a `[ ]` test, or one `[[ ]]` leaf, as the command it is: the shell
 * evaluates it itself, so no command gate saw its words, and a rule, an allow
 * list or a policy answers it by its own name as it answers `test` on the
 * same words. `name` is `[` or `[[`; `words` what it tests, expanded,
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
  const classified = classifiedWords(name, words, session, registry)
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
    throw new CondRefused(verdict.stderr, verdict.exitCode, verdict.refusal)
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
    Object.hasOwn(session.functions, joined) ||
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
 * here and the dispatcher judges the write.
 */
function statementRedirectsRaw(node: TSNodeLike): Redirect[] {
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

/** Mark redirected input without opening or expanding its source. */
export function statementStdin(node: TSNodeLike): Uint8Array | null {
  return statementRedirectsRaw(node).some((r) => r.fd === 0) ? new Uint8Array(0) : null
}

export function statementRedirects(node: TSNodeLike, home: string | null): Word[] {
  const words: Word[] = []
  for (const r of statementRedirectsRaw(node)) {
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

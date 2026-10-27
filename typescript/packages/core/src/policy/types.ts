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

import { z } from 'zod'
import type { FileView, SessionAccess } from '../view/types.ts'
import type { VfsCall } from '../vfs/types.ts'
import type { ScriptSource } from '../runtime/types.ts'
import type { SecretRef } from '../secrets/config.ts'
import type { Limit, MountMode, PathSpec, Producer, Refusal } from '../types.ts'
import type { WordKind } from '../commands/spec/types.ts'
import type { SessionView } from '../view/types.ts'

/**
 * The one registry question policy methods may ask. MountRegistry
 * satisfies this structurally; the narrow interface keeps this package
 * a leaf (no workspace imports), so the registry can host a Policies
 * instance without a cycle. Mirrors the Python MountRootQuery.
 */
export interface MountRootQuery {
  isMountRoot(path: string): boolean
}

/**
 * What the profile's rules say about one line: the document's own three
 * verbs and nothing else.
 *
 * ALLOW is silence as well as consent, since a line no rule speaks
 * about runs. DENY covers both refusals, and `Ruling.rule` tells them
 * apart: a rule refused it, or, with no rule, the allow list did. Both
 * exit 126; only the wording differs, because one has an operator's
 * reason to print and the other has none.
 */
export enum Outcome {
  ALLOW = 'allow',
  ASK = 'ask',
  DENY = 'deny',
}

/**
 * Refuse the command, op or session write, with a reason. Rendered by
 * the entry point it fires at. The command plane prints bash's own
 * `<cmd>: Permission denied` at 126; a Deny about a `path` prints the
 * command's own line for that path and `Permission denied` at the
 * command's operand exit code (1, tar 2); a Deny carrying an `error` is
 * that error, its reason the command's own diagnostic, `<cmd>: <reason>`,
 * at the same code. The dispatcher throws `error`, else EACCES; the
 * session view EACCES. `kind` is the wire discriminant shared with
 * Python.
 */
export interface Deny {
  kind: 'deny'
  /** Why, without the command name and without a trailing newline; the entry point adds both. */
  reason: string
  /** The class name of the policy that spoke, stamped by the chain so no policy names itself. */
  policy?: string
  /** True when the chain refused on a policy's behalf because it raised. */
  failed?: boolean
  /** The specific error this refusal is (EBUSY on a mount root, EROFS on a
   * read-only mount); absent for a permission refusal. */
  error?: Error
  /** The path the refusal is about, as typed; absent refuses the command
   * whole. */
  path?: string
  /** The profile rule that refused, as an Ask carries the rule that asked;
   * absent for a coded condition. */
  rule?: CommandRule
}

/**
 * Place a line on a runtime, the answer `preExecute` gives beside a Deny.
 *
 * The runtime serves every command it captures on the line, as a
 * `routePolicy` verdict naming it does. A Deny at the stage outranks it,
 * and two policies placing one line on different runtimes refuse the
 * line, since neither choice is the line's. Mirrors the Python `Route`.
 */
export interface Route {
  kind: 'route'
  /** The runtime entry's name. */
  runtime: string
  /** The policy that placed the line; the chain fills it in. */
  policy?: string
}

/**
 * One admission rule of the permissions document: refuse (or ask about)
 * matching commands, on matching paths when it names any. It is the
 * compiled element of `commands.deny` and `commands.ask` wherever the
 * profile writes one, and reaches the workspace only inside that document;
 * `PermissionsPolicy` is what evaluates it. The document writes a rule in one of
 * three shapes, and each compiles to rules of this shape: a list of
 * command patterns (a whole-line rule on each, no paths), a mapping of
 * command pattern to its paths (one command to many paths, one rule per
 * command, so a path is never stated beside a command it was not meant
 * for), or paths alone (a rule on every command, at the dispatcher too). A
 * command entry is a token-prefix pattern over the line as the entry point
 * normalizes it (`rm` is every rm line, `git push` every `git push ...`,
 * a `*` token any one token). Path entries use the document's one
 * grammar: an entry with `*`, `?` or `[` is a pattern (repo fnmatch
 * dialect, `*` crossing `/`, a slashless pattern matching any name
 * component), anything else is an exact path and its subtree. An entry
 * holds a token (a blank one would be the root), is absolute or a name
 * pattern, and inside a mount section must name something under that
 * mount root. Empty `commands` means every command, and a path-scoped
 * rule carries exactly one; empty `paths` refuses the command
 * regardless of its operands. `mount` is set by the compiler for a rule
 * written under a `mounts.<prefix>` section (the mount root the rule is
 * scoped to: it applies only to a line whose cwd or paths lie under
 * it), never typed.
 */
export interface CommandRule {
  reason: string
  commands?: readonly string[]
  paths?: readonly string[]
  mount?: string
}

/**
 * Why one group of hide entries exists, for the operator only.
 *
 * The document may state a hide as `{patterns: [...], reason: ...}`;
 * the patterns compile into the flat hide spec like any other entry,
 * and this side table keeps the reason beside them for the host's
 * entry points (audit, read-back). It is never rendered to the agent: a hide
 * answers ENOENT, and a reason on a nonexistent path would confirm the
 * path exists.
 */
export interface HideReason {
  readonly patterns: readonly string[]
  readonly reason: string
}

/** The profile's answer about one line, and what produced it. */
export interface Ruling {
  /** Which verb spoke. */
  readonly outcome: Outcome
  /**
   * The rule that spoke; null on ALLOW, and on the DENY the allow list
   * produces, which is not a rule and so has no reason of its own to
   * print.
   */
  readonly rule: CommandRule | null
  /**
   * The operand a path-scoped rule matched, as typed, which the GNU
   * line names (`rm: cannot remove 'letters.txt': Permission denied`);
   * null when the rule reaches the whole line.
   */
  readonly matchedPath: string | null
  /**
   * Where in the document the rule was written, for a host reading a
   * decision: `top` or `mounts./repo`. Empty on ALLOW, and
   * `commands.allow` on the DENY the allow list produces, which is the
   * one place a source names no rule.
   */
  readonly source: string
  /**
   * Every ask that won a subject of its own, `rule` among them, in the
   * order the subjects were read. Only ASK fills it, and the line runs
   * only once each has been answered: one nod covers the subject it was
   * given for and no other, so a deeper ask on a destination cannot
   * carry a source past the ask written for it. One entry is the
   * ordinary case.
   */
  readonly asks: readonly CommandRule[]
}

/**
 * Go on only with a host approval. Every method may answer one.
 * `PermissionsPolicy` returns one for a `commands.ask` rule, a custom
 * policy for a coded condition, and both route to the workspace's
 * decision ledger (`Decisions`). A Deny from any policy outranks it: the
 * chain keeps looking past an Ask for a Deny, so an approval can never
 * re-open a refusal. A later Ask's rules are appended to the first one's
 * `rules`, so every Ask a method's chain answers is put to the host. A pre
 * method holds what it guards
 * until the host says yes; a post method holds back what came back, and
 * the approved rerun repeats the action. `rule` is the document rule
 * that asked, absent for a coded condition, for which the ledger keys a
 * session answer on what was asked about. Mirrors the Python Ask.
 */
export interface Ask {
  kind: 'ask'
  /** Why the line needs sign-off, shown to the agent and the host. */
  reason: string
  rule?: CommandRule
  /**
   * Every rule the line has to be granted, `rule` among them and usually
   * alone: a line whose operands were each asked about by a different
   * rule carries them all, as does the first Ask of a chain that answered
   * more than one. The entry point asks about them one at a time and runs
   * the line only once each is answered, so a nod given for one operand
   * cannot carry another. Absent for a coded Ask, whose one rule
   * the entry point synthesizes.
   */
  rules?: readonly CommandRule[]
  /** The policy that asked, as `explain` names it. */
  policy?: string
}

/**
 * The closed vocabulary of policy answers, ranked by kind: Deny (first
 * opinion wins), then Ask (defers to the host; a Deny anywhere in the
 * chain still wins), then Route and Limit (every Route has to agree; every
 * Limit merges to the tightest, Limit.aggr). A method returns an Action to
 * state an opinion or null to stay silent; each method accepts a fixed set
 * of kinds (VALIDITY), enforced at the seam.
 */
export type Action = Deny | Limit | Ask | Route

/**
 * How far an answer reaches.
 *
 * ONCE answers the one line that asked and is consumed by it, so the
 * next identical line asks again. SESSION answers every line the same
 * rule covers for the rest of the session. Nothing reaches further: an
 * answer is never inherited by another session, and never re-opens a
 * deny rule, which is consulted first. Mirrors the Python Scope.
 */
export enum Scope {
  ONCE = 'once',
  SESSION = 'session',
}

/**
 * One asked line, and the answer to it once a host gives one.
 *
 * The ledger's entry, and the only shape the permissions layer keeps
 * about an ask. It is written when a rule asks and rewritten when a
 * host answers, so listing what is waiting and reading what was settled
 * are the same query over the same records rather than two stores that
 * can disagree.
 *
 * A retry is matched by comparing `command`, `argv` and `cwd` against
 * what was recorded, not by re-deriving an id, so two lines that differ
 * only where the recorded fields differ can never collide.
 *
 * `outcome` is the host's answer, ALLOW or DENY, and null while nobody
 * has answered. ASK is not an answer, it is the question. Mirrors the
 * Python Decision.
 */
export interface Decision {
  id: string
  sessionId: string
  command: string
  argv: readonly string[]
  cwd: string
  paths: readonly string[]
  reason: string
  rule: CommandRule
  outcome: Outcome | null
  scope: Scope
  note: string
}

/**
 * Where one command stands: the text it was parsed from, its span in
 * that text, and the occurrence of the node that text was evaluated
 * from, so the commands of a nested line stand under the word that ran
 * them.
 *
 * The pass computes one from the line's parse and the gate from the
 * node it runs, by one rule (`workspace/node/occurrence`), and the
 * ledger only compares them: a grant a pass claims is bound to the
 * occurrence it judged, and offered to a reader at that occurrence
 * alone. So a word that expands at run time into the same command as a
 * literal spelling elsewhere on the line (`$S && cat secret`) cannot
 * run on the literal's nod, and one body evaluated under two words
 * (`eval 'cat s'; eval 'cat s'`) is two occurrences. Mirrors the Python
 * Occurrence.
 */
export interface Occurrence {
  /** The node whose text this command was parsed from, null for a typed line. */
  readonly parent: Occurrence | null
  /** The text the command was parsed from. */
  readonly source: string
  /** The command's first index in that text. */
  readonly start: number
  /** The index after its last. */
  readonly end: number
}

/**
 * One grant a reader of a line matched, and the occurrence it matched
 * it for. Mirrors the Python Claim.
 */
export interface Claim {
  readonly occurrence: Occurrence
  readonly decision: Decision
}

/**
 * The ONCE grants a line's readers matched to its commands, for the
 * line's end to spend.
 *
 * One per line, made by the executor and filled by `Decisions.resolve`
 * as a pass or a gate admits a command: every grant it matches, whether
 * the host gave it inline just now or out of band before the line, is
 * claimed here instead of spent, bound to the occurrence it was judged
 * for. A claimed grant is on offer to that occurrence alone, so two
 * spellings of one command on a line each need a nod of their own, and
 * invisible to every other line of the session while this one lives, so
 * two lines judged at once cannot both run on one nod. Nothing spends a
 * claim while the line runs: a gate the run reaches again at the same
 * place (a loop body) runs on the same nod, and every claim, reached or
 * not, is spent when the line ends (`Decisions.revoke`). A background
 * job the line launches holds a copy of the claims made for the
 * commands inside it on a hand-off of its own (`Decisions.split`),
 * since its gates run after the line has returned and it ends on its
 * own clock; a grant is spent when the last hand-off holding it ends.
 * Compared by identity, because the hand-off is the line.
 *
 * A line the executor evaluates from inside another (`$( )`, `eval`,
 * `source`, `xargs`, the line an alias invocation rewrites to) is a line
 * of its own with a hand-off of its own,
 * linked to the outer line's through `parent` and standing under the
 * node that ran it through `origin`: the outer pass reads into the
 * words it runs, so the grants it claimed for them are the inner line's
 * to run on, at the occurrences the outer pass computed for them, and
 * what the inner line's own gates claim is handed to the outer line
 * when it ends (`Decisions.handUp`), for the next evaluation from the
 * same node to run on and the typed line's end to spend. Mirrors the
 * Python HandOff.
 */
export interface HandOff {
  /** The grants matched so far, in the order the commands were judged. */
  readonly claimed: Claim[]
  /**
   * The hand-off of the line this one was evaluated from, null for a
   * typed line.
   */
  readonly parent: HandOff | null
  /** The node this line's text was evaluated from, null for a typed line. */
  readonly origin: Occurrence | null
}

/** The ledger owning a hand-off, compared only by identity. */
export abstract class DecisionOwner {
  declare protected readonly decisionOwner: undefined
}

/**
 * Who reads the ledger: one command of one line. A judging pass and the
 * gate that runs the line name themselves the same way, so a grant the
 * pass claimed for a command is found by the gate for that command and
 * by no other reader. Mirrors the Python Claimant.
 */
export interface Claimant {
  readonly line: HandOff
  readonly occurrence: Occurrence
}

/**
 * The entry point's answer while the host has not decided: the line is refused
 * for now, and the id names what to grant. Mirrors the Python Pending.
 */
export interface Pending {
  kind: 'pending'
  id: string
  reason: string
}

/**
 * The question was abandoned: the run that raised it was killed while
 * the host was still deciding, so the ledger stopped waiting.
 *
 * The record is left waiting, and whatever the host eventually answers
 * is dropped rather than recorded — an answer banked against a run that
 * no longer exists would be taken by the next identical line with
 * nobody asked. The entry point turns this into the same abort every other
 * killed wait raises; the ledger states the fact in its own vocabulary
 * because execution is not its to know about.
 */
export interface Abandoned {
  kind: 'abandoned'
}

/**
 * The session questions the approval ledger asks. The SessionManager
 * satisfies it structurally, so the dispatcher reads and writes a session's
 * grants by id without this package importing the workspace, and always
 * on the registered session rather than the fork a line may be running
 * in. Mirrors the Python SessionDecisionsQuery.
 */
export interface SessionDecisionsQuery {
  decisionSessions(): readonly string[]
  decisionsOf(sessionId: string): readonly Decision[]
  setDecisions(sessionId: string, records: readonly Decision[]): void
  flush(): Promise<void>
}

/**
 * One profile's admission rules, compiled: the whole permission document a
 * session runs under. A session is evaluated against exactly one of
 * these. It holds the profile's allow list, its ask and deny rules, and
 * the rules its mount sections carry, each stamped with the mount it
 * was written under so it applies to a line working inside that mount.
 * There is nothing above it and nothing beside it: two rules that both
 * match are resolved by anchor depth, then by verb (`policy/match/
 * decide`). `allow` null when the profile states no list.
 */
export interface AdmissionRules {
  allow: readonly string[] | null
  ask: readonly CommandRule[]
  deny: readonly CommandRule[]
}

/**
 * The one session question the permissions policy asks. The
 * SessionManager satisfies it structurally, so the policy reads the
 * rules by session id without this package importing the workspace.
 * An id the manager does not know (or the empty id of an unbound entry point)
 * answers the default profile's rules, so it still fails toward refusal.
 */
export interface SessionCommandsQuery {
  commandsOf(sessionId: string): AdmissionRules | null
}

/** A method a profile's policy names programs for, as the Policy interface spells it. */
export type ScriptMethod =
  | 'preExecute'
  | 'preCommand'
  | 'preVfs'
  | 'preSession'
  | 'postExecute'
  | 'postCommand'
  | 'postVfs'
  | 'postSession'

/**
 * One program of a profile's policy, as a session carries it: the
 * program, the runtime it runs on with that runtime's settings, and the
 * profile it speaks for. Compiled off the profile's policy block beside
 * the admission rules, one per entry of a method's list, and run by
 * `ScriptPolicy` at that method with the context as JSON
 * (`scriptContext`) in `MIRAGE_POLICY_CTX` and on stdin; `scriptAction`
 * reads the answer it prints. `profile` is the profile's name, which
 * every refusal about its program prints; empty for a profile document
 * passed to `createSession` without a name. `env` is the variables the
 * program runs with beside `MIRAGE_POLICY_CTX`, a pointer still the
 * pointer.
 */
export interface ProfileScript {
  readonly profile: string
  readonly script: ScriptSource
  readonly runtime: string
  readonly config: Readonly<Record<string, unknown>>
  readonly env: Readonly<Record<string, string | SecretRef>>
}

/** A session's policy programs, by method. */
export type ProfileScripts = Readonly<Partial<Record<ScriptMethod, readonly ProfileScript[]>>>

/**
 * The one session question the script policy asks, satisfied the same
 * way `SessionCommandsQuery` is: the policy reads a session's programs
 * by the id the entry point put in the context, falling back to the
 * default profile's for an id the manager does not know.
 */
export interface SessionScriptsQuery {
  scriptsOf(sessionId: string): ProfileScripts
}

/**
 * A policy answer as JSON carries it: its kind and its own fields. What a
 * policy program prints, and what the server's entry points send
 * (`answerToDict`, which adds the policy that spoke). A deny or an ask
 * may leave the reason out for the default one; a route names its
 * runtime. Mirrors the Python `Answer`.
 */
export const Answer = z
  .strictObject({
    kind: z.enum(['deny', 'ask', 'route']),
    reason: z.string().nullable().optional(),
    runtime: z.string().nullable().optional(),
  })
  .superRefine((answer, check) => {
    if (answer.kind === 'route') {
      if (!answer.runtime || (answer.reason ?? null) !== null) {
        check.addIssue({ code: 'custom', message: 'a route names its runtime and nothing else' })
      }
    } else if ((answer.runtime ?? null) !== null) {
      check.addIssue({ code: 'custom', message: `a ${answer.kind} carries no runtime` })
    }
  })

export type Answer = z.infer<typeof Answer>

/**
 * One word of a command line, as the grammar read it: the word as the
 * command receives it, expanded; what it is (the command name, a CLI verb,
 * an option, an option's value, an operand or a redirect target); for a
 * value, the option word that takes it, as typed; and the path it names,
 * null for a word that names none. Mirrors Python's `CommandWord`.
 */
export class CommandWord {
  constructor(
    readonly text: string,
    readonly kind: WordKind,
    readonly option: string | null = null,
    readonly path: PathSpec | null = null,
  ) {}

  /**
   * The word as plain data: its text, its kind, the option a value belongs
   * to and the virtual path it names, each null where it has none.
   */
  toDict(): Record<string, string | null> {
    return {
      text: this.text,
      kind: this.kind,
      option: this.option,
      path: this.path !== null ? this.path.virtual : null,
    }
  }
}

/** The session a call is made as, as a method reads it. Mirrors Python's `CallerSession`. */
export interface CallerSession {
  readonly sessionId: string
  /** Its working directory when the method was asked. */
  readonly cwd: string
}

/**
 * Who makes the call a method judges, as the method reads it: a frozen copy
 * of the facts, so nothing a method does to it reaches the session or the
 * call. `session` is null for the unbound host view. Mirrors Python's
 * `PolicyCaller`.
 */
export interface PolicyCaller {
  readonly session: CallerSession | null
}

/** The session identity a policy may read, without owning its state. */
export interface CallerSessionQuery {
  readonly sessionId: string
  readonly cwd: string
}

/**
 * `session` as a method's `ctx.caller` reads it. Mirrors Python's
 * `policy_caller`.
 */
export function policyCaller(session: CallerSessionQuery | null): PolicyCaller {
  return Object.freeze({
    session:
      session === null ? null : Object.freeze({ sessionId: session.sessionId, cwd: session.cwd }),
  })
}

/** Facts about one classified command, as preCommand methods see it. */
export interface CommandContext {
  /** The session's files; policy writes are refused by the dispatcher. */
  vfs?: FileView
  /**
   * The line the command was parsed from: the line the agent typed, or
   * for a command a line runs in turn (`eval`, `$( )`, a function body)
   * that line's text. Absent outside a line.
   */
  line?: string
  command: string
  /**
   * Every path the line names: the positional operands first, then the
   * values of any path-valued flags. What a path-pattern guard matches on.
   */
  paths: readonly PathSpec[]
  /**
   * The command line word by word, the name first and redirect targets
   * last, each with its kind. A rule that reads a slot (mv's source, ln's
   * target, tar's files) reads the operands here: `tar -xf a.tar -C /mnt`
   * names `/mnt` as `-C`'s value, not as a file.
   */
  words?: readonly CommandWord[]
  /** Raw argv after the command name; methods fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  /** The session running the line, set by the entry point; empty outside a workspace. */
  sessionId?: string
  /**
   * The line as an admission pattern reads it, command name first: for
   * an installed CLI the verb path replaces the words before it (options
   * before the verb dropped, an alias canonicalized), then the leaf's
   * own words; for anything else the name and the raw argv.
   */
  tokens?: readonly string[]
  /** The head of `tokens` that names what runs: the name plus a CLI's verb path. */
  program?: readonly string[]
  /**
   * Whether the word is a tool the allow lists govern, which every
   * named command is, shell builtins included. The entry point clears it for
   * the agent's own function where the function is what runs, and for
   * an executed path: neither is a name a list could hold, and every
   * line either runs passes the gate itself, so an allow list never
   * refuses them, though a deny rule still can. Absent reads as true.
   */
  tool?: boolean
  /**
   * Whether the command descends its directory operands (`find`, `du`,
   * `tree`, `rg`, `grep -r`, `ls -R`), so a mount whose root sits under
   * one of its paths is a mount the line works inside: the executor's
   * fan-out reruns the traversal in each descendant mount, and no
   * admission fires again there. Absent reads as false.
   */
  walks?: boolean
  /**
   * Whether the handler this command resolves to declares that it may
   * change state (`CLIHandler.write`, `Command.write`): an installed CLI's
   * or a mount tree's leaf as the walk names it, a mount command as the
   * mount that would run it resolves it, and a builtin only when its options
   * let it write (`sort -o` writes, `sort` does not). False for a shell
   * builtin, a function, an external program and an unknown name. Absent
   * reads as false.
   */
  write?: boolean
  /** The session, read only: a write through it is refused. Filled when a method is asked. */
  session?: SessionView
  /**
   * Who makes the call, read only: its `session` is the session above
   * (`sessionId`, `cwd`). Filled when a method is asked.
   */
  caller?: PolicyCaller
}

/**
 * One line, as preExecute methods see it: the line and every command in
 * it, each as `preCommand` will see it. `commands` lists them in source
 * order, nested ones included, each read as the gate that runs it will
 * read it: its words expanded where the text alone says what they are,
 * its paths resolved; a command whose name only the run expands is left
 * out. A script gets the same as plain data (`scriptContext`), with
 * `ctx.runtime` naming the runtime when a runtime's own `script:` is
 * asked.
 *
 * For `cat /data/logs.txt | python3 process.py` typed in `/data`:
 *
 * ```
 * ctx.line === 'cat /data/logs.txt | python3 process.py'
 * ctx.commands.map((c) => c.command)  // ['cat', 'python3']
 * ctx.commands[1].paths.map((p) => p.virtual)  // ['/data/process.py']
 * ctx.session.cwd() === '/data'
 * ```
 */
export interface RouteContext {
  /** The session's files; policy writes are refused by the dispatcher. */
  vfs?: FileView
  line: string
  commands: readonly CommandContext[]
  sessionId: string
  /** The session, read only: a write through it is refused. */
  session?: SessionView
  /**
   * Who makes the call, read only: its `session` is the session above
   * (`sessionId`, `cwd`). Filled when a method is asked.
   */
  caller?: PolicyCaller
}

/** Facts about one VFS op, as preVfs methods see it. Fires at the
 * dispatcher (every access routes through it, FUSE included),
 * before any backend or cache I/O. `sessionId` is the session the dispatcher
 * serves, set from the session it already resolves for hides and
 * modes; empty for the unbound host view. `issuer` is the token the op
 * arrived with, when its caller stamped one: a policy whose own engine
 * reads through the dispatcher stamps those reads, and recognizes its token
 * here so the read an evaluation is waiting on is not judged by the
 * method that is waiting. It travels with the op as an argument, never
 * through ambient context, so no concurrent op can be taken for it;
 * python marks the same read with a task-local ContextVar, which a
 * browser has no twin of. */
export interface VfsContext {
  /** The session's files; policy writes are refused by the dispatcher. */
  vfs?: FileView
  access?: SessionAccess
  /** The rule gate of the command that issued the op, when the op carries
   * one; the bound admission answers otherwise. */
  gate?: EntryGate | null
  /** The function called, as `vfsCall` declares it; a rename's or a copy's
   * destination is judged under the same call with `creates` set. */
  call: VfsCall
  path: PathSpec
  /** Whether the call mutates this path; a copy only reads its source. */
  write: boolean
  prefix: string
  sessionId?: string
  issuer?: symbol
  /** The owning mount's mode, judged by the mount-mode built-in; unset at
   * an entry point that judges it itself. */
  mode?: MountMode
  /** The session, read only. */
  session?: SessionView
  /**
   * Who makes the call, read only: its `session` is the session above
   * (`sessionId`, `cwd`). Filled when a method is asked.
   */
  caller?: PolicyCaller
}

/**
 * One command or CLI that ran, as postCommand methods see it: what
 * preCommand saw, plus what came back. `exitCode` is settled once its
 * output drained; `records` are its op records as `OpRecord.toJSON`
 * writes them. Mirrors the Python CommandResultContext.
 */
export interface CommandResultContext extends CommandContext {
  exitCode: number
  stderr: string
  records: readonly Record<string, unknown>[]
}

/** One completed VFS op, as postVfs methods see it: what preVfs saw,
 * plus what came back; a Deny or an Ask drops the result. */
export interface VfsResultContext extends VfsContext {
  result: unknown
}

/**
 * One finished line, as postExecute methods see it: what preExecute saw,
 * plus what came back. Fires at the workspace boundary before the
 * line's output reaches the caller, so a Limit returned here bounds
 * what the caller sees, and a Deny or an Ask drops it. `producer` is
 * the provenance of the surviving stream (the rightmost command, per
 * shell semantics), with an empty command when no dispatch site stamped
 * one. Mirrors the Python ExecuteResultContext.
 */
export interface ExecuteResultContext extends RouteContext {
  producer: Producer
  exitCode: number
  /** What the line wrote to stdout. */
  output: Uint8Array
  /**
   * What each command returned, as the line's execution tree
   * (`ExecutionNode.toJSON`): a leaf per command with its exit code,
   * stderr and op records, under the operators that joined them.
   */
  results: Record<string, unknown>
}

/**
 * Facts about one session-state mutation, as preSession methods see it.
 * Fires on the session plane before the write lands, so it holds
 * whichever tier asked. Not an VfsContext: a session key is not a
 * path, and a path-scoped policy must never receive one dressed as a
 * path and match it by accident. `value` is null for an unset.
 * `sessionId` says which session is writing, so a policy can scope a
 * rule to one agent (deny `set` for session X).
 */
export interface SessionContext {
  /** The session's files; policy writes are refused by the dispatcher. */
  vfs?: FileView
  verb: string
  key: string
  value: string | null
  sessionId: string
  /** The session, read only. */
  session?: SessionView
  /**
   * Who makes the call, read only: its `session` is the session above
   * (`sessionId`, `cwd`). Filled when a method is asked.
   */
  caller?: PolicyCaller
}

/**
 * One session write that landed, as postSession methods see it: what
 * preSession saw, plus the value it replaced (`old`, rendered as `value`
 * is; null when the name was unset). Mirrors the Python
 * SessionResultContext.
 */
export interface SessionResultContext extends SessionContext {
  old: string | null
}

export const VALIDITY: Readonly<
  Record<
    | 'preCommand'
    | 'postCommand'
    | 'preExecute'
    | 'preVfs'
    | 'postVfs'
    | 'postExecute'
    | 'preSession'
    | 'postSession',
    ReadonlySet<string>
  >
> = {
  preCommand: new Set(['deny', 'ask']),
  postCommand: new Set(['deny', 'ask']),
  preExecute: new Set(['deny', 'ask', 'route']),
  preVfs: new Set(['deny', 'ask']),
  postVfs: new Set(['deny', 'ask']),
  postExecute: new Set(['deny', 'ask', 'limit']),
  preSession: new Set(['deny', 'ask']),
  postSession: new Set(['deny', 'ask']),
}

/** The name of one Policy method, as the interface spells it. */
export type PolicyMethod = keyof typeof VALIDITY

/**
 * What a dry run's calls are while the policies decide the op it
 * explains. DECIDING is a policy's own ops: a read runs for real, a
 * refusal throws the entry point's error with no question recorded, and a write
 * is refused as on a read-only mount, so an explanation changes nothing.
 * Mirrors the Python DryRun.
 */
export enum DryRun {
  DECIDING = 'deciding',
}

/**
 * What the policies decide about one thing a session would do, without
 * doing it: the verdict every explanation carries. Produced by the same
 * gates the dispatcher runs, so a host reading one and an agent running
 * the call cannot be told different things. A line (`ShellExplanation`),
 * each of its commands (`CommandExplanation`) and a VFS call
 * (`VfsExplanation`) extend it with what is theirs; `answers` holds what
 * the method judging that level said. Mirrors the Python Explanation.
 */
export interface Explanation {
  /** `ALLOW`, `DENY` or `ASK` (an ask an approval already covers stays `ASK` with no refusal). */
  readonly outcome: Outcome
  /** Why, in the deciding policy's words; empty when nothing refuses or asks. */
  readonly reason: string
  /**
   * Where in the profile the deciding rule is written (`top`,
   * `mounts./runbook`, `commands.allow` for the allow list); empty when no
   * rule decided.
   */
  readonly source: string
  /**
   * Every policy's answer, in the order the chain asks them, each naming
   * its policy; the profile's rules answer as `PermissionsPolicy`. A hide
   * is never among them.
   */
  readonly answers: readonly (Deny | Ask | Route)[]
  /** The record a refused run carries, null when it would run. */
  readonly refusal: Refusal | null
}

/**
 * One piece of a line's structure, as the shell parses it: `list` (`;`
 * `&&` `||` `&`), `pipeline`, `subshell`, `group` (braces and the bodies
 * of `if`, `for`, `while`, `case` and functions), `line` (a line a command
 * runs: `bash -c`, `eval`, `xargs`) or `substitution` (`$( )`, backticks,
 * `<( )`). Mirrors the Python ShellNode.
 */
export interface ShellNode {
  readonly type: string
  /** The node's source text. */
  readonly text: string
  /** What it holds, in source order. */
  readonly children: readonly (ShellNode | CommandExplanation)[]
}

/**
 * One command of a line, explained: whether it may run (its `preCommand`
 * answers) and where it would run. Mirrors the Python CommandExplanation.
 */
export interface CommandExplanation extends Explanation {
  readonly type: 'command'
  /** Every policy's answer to the command (`preCommand`). */
  readonly answers: readonly (Deny | Ask)[]
  /** The program, as the gate read it. */
  readonly command: string
  /**
   * The command line word by word, each with its kind and the path it
   * names. A path the session cannot see is listed like any path no rule
   * matches: it is resolved from the cwd alone, links unfollowed, so it
   * names nothing the session could not type.
   */
  readonly words: readonly CommandWord[]
  /** What the command would exit with where it stands, 0 to run. */
  readonly exitCode: number
  /** What the agent would read from it, empty to run. */
  readonly stderr: string
  /** The runtime entry that would run it, empty when the workspace runs it itself. */
  readonly runtime: string
  /** The command's source text. */
  readonly text: string
  /** The lines it runs in turn (`$( )` in its words, a `bash -c` string), in source order. */
  readonly children: readonly ShellNode[]
}

/**
 * A line, explained: what the agent would read, where the line would run
 * (its `preExecute` answers) and every command in it. The verdict is
 * whether the line runs at all: a rule's refusal, or a question still
 * waiting on the host, refuses the whole line before any of it runs, as
 * does a placement's refusal; the first in the order the gate reads them
 * is the line's, byte-identical to the refusal the run reports. A line
 * that runs exits 0 here, and one an approval lets run carries the ask it
 * covers. A command refused where it stands while the rest of the line
 * runs (a word the allow list leaves out, a policy refusing one path)
 * says so on its own node. Mirrors the Python ShellExplanation.
 */
export interface ShellExplanation extends Explanation {
  /**
   * Every policy's answer to the line as a whole (`preExecute`), the route
   * policy's first; empty when no policy answers it or a command refuses
   * it first.
   */
  readonly answers: readonly (Deny | Ask | Route)[]
  /** The line as given. */
  readonly line: string
  /** What the line is refused with, 0 when it runs. */
  readonly exitCode: number
  /** What the agent would read then, empty when it runs. */
  readonly stderr: string
  /** The parsed line, of type `line`. */
  readonly node: ShellNode
}

/**
 * A VFS call, explained: the POSIX-shaped call on `session.vfs` (`read`,
 * `pwrite`, `rename`, `setxattr`, ...) and what its gate (`preVfs`) would
 * answer. Mirrors the Python VfsExplanation.
 */
export interface VfsExplanation extends Explanation {
  /** Every policy's answer to the call (`preVfs`). */
  readonly answers: readonly (Deny | Ask)[]
  /** The call's name. */
  readonly call: string
  /** Its path arguments, as given. */
  readonly paths: readonly string[]
  /** The errno name the call would throw (`EACCES`, `EROFS`), empty when it would run. */
  readonly error: string
}

/**
 * What a command's own I/O asks before touching an entry it reached
 * below its operands.
 *
 * The admission gate judges the paths a line names; a walk (`grep -r`,
 * `find`, `du`, `cp -r`, `tar`) then reaches entries no rule has seen.
 * The dispatcher binds the admitted command's gate to the session
 * context for the command's run, and the commands tier reads it there,
 * so the tier that enforces the rules never imports the tier that
 * states them. `check` throws when a rule in force refuses the entry for
 * the running command and returns when the command may touch it.
 */
export interface EntryGate {
  /**
   * The ask rules this line runs under a grant for. Read by the
   * dispatcher, which sees the same entries from below and would otherwise
   * re-derive a verdict that knows nothing of the nod the gate already
   * took.
   */
  readonly granted: readonly CommandRule[]
  /**
   * The paths the line names, which the gate judged. Read by the dispatcher,
   * which checks a named path against the backend under `read: fresh` the
   * first time the command looks it up, and leaves the entries a walk reaches
   * to their listings.
   */
  readonly judged: ReadonlySet<string>
  check(virtual: string): void
  /** Whether anything at or under this path could be refused for the
   * running command, so a native walk there gives way to the guarded one;
   * asked per operand. */
  scopes(virtual: string): boolean
  /**
   * The reason a rule in force refuses this entry for the running command,
   * null when it may touch it: `check`'s answer, asked without refusing, for
   * a reader choosing among places that hold the same bytes.
   */
  refusal(virtual: string): string | null
}

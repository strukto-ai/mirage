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

import type { ScriptSource } from '../runtime/routing/types.ts'
import type { Limit, PathSpec, Producer, Refusal } from '../types.ts'

/**
 * The one registry question policy hooks may ask. MountRegistry
 * satisfies this structurally; the narrow interface keeps this package
 * a leaf (no workspace imports), so the registry can host a Policies
 * instance without a cycle. Mirrors the Python MountRootQuery.
 */
interface MountRootQuery {
  isMountRoot(path: string): boolean
}

/**
 * What a command-plane refusal is about, which picks its voice. `command`
 * refuses the whole line in bash's own words, `<cmd>: Permission denied`,
 * exit 126, and the reason rides the result's `refusal` record instead.
 * `operand` refuses one operand and keeps the GNU voice `<cmd>: <reason>`
 * (the reason names the operand, as `rm: cannot remove 'x': ...` does),
 * exit 1, or the command's own fatal code where GNU differs (tar exits
 * 2). The exit code and errno derive from the plane and this scope,
 * never from a number a policy picks, so a document deny and a coded
 * one are indistinguishable. Mirrors the Python DenyScope.
 */
export type DenyScope = 'command' | 'operand'

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
 * the door it fires at: the command plane prints it in the scope's voice
 * (DenyScope), the op doors throw EACCES with it, the session door
 * EACCES too. `kind` is the wire discriminant shared with Python.
 */
export interface Deny {
  kind: 'deny'
  /** Why, without the command name and without a trailing newline; the door adds both. */
  reason: string
  /** Whole command (the default) or one operand; ignored off the command plane. */
  scope?: DenyScope
  /** The class name of the policy that spoke, stamped by the chain so no policy names itself. */
  policy?: string
  /** True when the chain refused on a policy's behalf because it raised. */
  failed?: boolean
}

/**
 * One admission rule of the permissions document: refuse (or ask about)
 * matching commands, on matching paths when it names any. It is the
 * compiled element of `commands.deny` and `commands.ask` wherever the
 * profile writes one, and reaches the workspace only inside that document;
 * the internal
 * RulePolicy is what evaluates it. The document writes a rule in one of
 * three shapes, and each compiles to rules of this shape: a list of
 * command patterns (a whole-line rule on each, no paths), a mapping of
 * command pattern to its paths (one command to many paths, one rule per
 * command, so a path is never stated beside a command it was not meant
 * for), or paths alone (a rule on every command, at the op door too). A
 * command entry is a token-prefix pattern over the line as the door
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
 * doors (audit, read-back). It is never rendered to the agent: a hide
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
   * voice prints (`rm: letters.txt: <reason>`); null when the rule
   * reaches the whole line.
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
 * Admit the command only with a host approval. A preCommand answer:
 * `PermissionsPolicy` returns one for a `commands.ask` rule, a custom
 * policy for a coded condition, and both route to the workspace's
 * decision ledger (`Decisions`). A Deny from any policy outranks it: the
 * chain keeps looking past an Ask for a Deny, so an approval can never
 * re-open a refusal. Command plane only: the op doors cannot wait on a
 * host. `rule` is the document rule that asked, absent for a coded
 * condition, for which the ledger keys a session answer on the program
 * that asked. Mirrors the Python Ask.
 */
export interface Ask {
  kind: 'ask'
  /** Why the line needs sign-off, shown to the agent and the host. */
  reason: string
  rule?: CommandRule
  /**
   * Every rule the line has to be granted, `rule` among them and usually
   * alone: a line whose operands were each asked about by a different
   * rule carries them all. The door asks about them one at a time and
   * runs the line only once each is answered, so a nod given for one
   * operand cannot carry another. Absent for a coded Ask, whose one rule
   * the door synthesizes.
   */
  rules?: readonly CommandRule[]
}

/**
 * The closed vocabulary of policy answers: a hook returns an Action to
 * state an opinion or null to stay silent. Deny refuses (first opinion
 * wins); Ask defers to the host (a Deny anywhere in the chain still
 * wins); Limit bounds (every opinion merges to the tightest,
 * Limit.aggr). Each hook accepts a fixed set of kinds (VALIDITY),
 * enforced at the seam.
 */
export type Action = Deny | Limit | Ask

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
  agentId: string
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
 * The door's answer while the host has not decided: the line is refused
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
 * nobody asked. The door turns this into the same abort every other
 * killed wait raises; the ledger states the fact in its own vocabulary
 * because execution is not its to know about.
 */
export interface Abandoned {
  kind: 'abandoned'
}

/**
 * The session questions the approval door asks. The SessionManager
 * satisfies it structurally, so the door reads and writes a session's
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
 * The rules that apply to one line, each with the verb it carries, deny
 * before ask and in the order written. Built once per line by `decide`
 * and read again at every subject of it.
 */
export type LiveRules = readonly (readonly [Outcome, CommandRule])[]

/**
 * The one session question the permissions policy asks. The
 * SessionManager satisfies it structurally, so the policy reads the
 * rules by session id without this package importing the workspace.
 * An id the manager does not know (or the empty id of an unbound door)
 * answers the default profile's rules, so it still fails toward refusal.
 */
export interface SessionCommandsQuery {
  commandsOf(sessionId: string): AdmissionRules | null
}

/**
 * One profile's policy, as a session carries it: the program, the
 * engine it runs on, and the profile it speaks for. Compiled off the
 * profile's policy block beside the admission rules; `ScriptPolicy`
 * calls the admission hooks it defines (`preCommand`, `preOps`,
 * `preSession`) with the door's facts, and a hook returns allow (no
 * opinion), deny, or at the command gate ask. `profile` is
 * the profile's name, which the policy reads as `ctx.profile`; empty
 * for a profile document passed to `createSession` without a name.
 */
export interface ProfileScript {
  readonly profile: string
  readonly script: ScriptSource
  readonly runtime: string
}

/**
 * The one session question the script policy asks, satisfied the same
 * way `SessionCommandsQuery` is: the policy reads a session's script by
 * the id the door put in the context, falling back to the default
 * profile's for an id the manager does not know.
 */
export interface SessionScriptsQuery {
  scriptOf(sessionId: string): ProfileScript | null
}

/** Facts about one classified command, as preCommand hooks see it. */
export interface CommandContext {
  command: string
  /**
   * Every path the line names: the positional operands first, then the
   * values of any path-valued flags. What a path-pattern guard matches on.
   */
  paths: readonly PathSpec[]
  /**
   * The positional operands alone. A rule that reads a slot by position
   * (mv's source, ln's target, tar's files) has to use this: with the flag
   * values mixed in, `tar -xf a.tar -C /mnt` would read the `-C`
   * destination as a file being archived.
   */
  operands?: readonly PathSpec[]
  /** Raw argv after the command name; hooks fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  registry: MountRootQuery
  /** The session running the line, set by the door; empty outside a workspace. */
  sessionId?: string
  /**
   * The agent the workspace attributes the line to, carried per
   * execution so a nested line (`eval`, `$()`, `xargs`) and a
   * concurrent one keep their own; what an approval request names.
   */
  agentId?: string
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
   * named command is, shell builtins included. The door clears it for
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
}

/** Facts about one VFS op, as preOps hooks see it. Fires at the op
 * door (the dispatcher every access routes through, FUSE included),
 * before any backend or cache I/O. `sessionId` is the session the door
 * serves, set from the session it already resolves for hides and
 * modes; empty for the unbound host view. `issuer` is the token the op
 * arrived with, when its caller stamped one: a policy whose own engine
 * reads through the door stamps those reads, and recognizes its token
 * here so the read an evaluation is waiting on is not judged by the
 * hook that is waiting. It travels with the op as an argument, never
 * through ambient context, so no concurrent op can be taken for it;
 * python marks the same read with a task-local ContextVar, which a
 * browser has no twin of. */
export interface OpsContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  sessionId?: string
  issuer?: symbol
}

/** One completed VFS op, as postOps hooks see it; a Deny suppresses
 * the result. */
export interface OpsResultContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  result: unknown
}

/**
 * One finished execute() line, as postExecute hooks see it. Fires at
 * the workspace boundary before the line's output stream is
 * finalized, so a Limit returned here bounds what the caller sees.
 * `producer` is the provenance of the surviving stream (the rightmost
 * command, per shell semantics), with an empty command when no
 * dispatch site stamped one.
 */
export interface ExecuteResultContext {
  producer: Producer
  exitCode: number
}

/**
 * Facts about one session-state mutation, as preSession hooks see it.
 * Fires on the session plane before the write lands, so it holds
 * whichever tier asked. Not an OpsContext: a session key is not a
 * path, and a path-scoped policy must never receive one dressed as a
 * path and match it by accident. `value` is null for an unset.
 * `sessionId` says which session is writing, so a policy can scope a
 * rule to one agent (deny `set` for session X).
 */
export interface SessionContext {
  plane: string
  verb: string
  key: string
  value: string | null
  sessionId: string
}

export const VALIDITY: Readonly<
  Record<'preCommand' | 'preOps' | 'postOps' | 'postExecute' | 'preSession', ReadonlySet<string>>
> = {
  preCommand: new Set(['deny', 'ask']),
  preOps: new Set(['deny']),
  postOps: new Set(['deny', 'limit']),
  postExecute: new Set(['limit']),
  preSession: new Set(['deny']),
}

/** The name of one Policy hook, as the interface spells it. */
export type PolicyHook = keyof typeof VALIDITY

/**
 * What one command of a line would do, without doing it.
 *
 * Produced by the same gate the dispatcher runs, so a host reading this
 * and an agent typing the line cannot be told different things.
 * Everything the agent would see is here as it would arrive: `exitCode`
 * and `stderr` come out of the one outcome table, so an explanation of a
 * refused line is byte-identical to the refusal.
 *
 * `outcome` is the document's answer and `rule` says who gave it. The
 * two refusals the allow list produces both arrive as `DENY` with no
 * rule, and `exitCode` separates them: 127 for a head word the session
 * cannot see, which reads as bash's "command not found" so an unlisted
 * tool never leaks that it exists, and 126 for a line whose head was
 * visible but which no allow entry covers.
 */
export interface Explanation {
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
}

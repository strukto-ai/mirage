# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar, Protocol

from mirage.runtime.types import ScriptSource
from mirage.types import Limit, MountMode, PathSpec, Producer, Refusal


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool: ...


class DenyScope(StrEnum):
    """What a command-plane refusal is about, which picks its voice.

    COMMAND refuses the whole line in bash's own words,
    ``<cmd>: Permission denied``, exit 126, and the reason rides the
    result's ``refusal`` record instead. OPERAND refuses one operand,
    exit 1, or the command's own fatal code where GNU differs (tar
    exits 2): with ``Deny.path`` set it prints the command's own GNU
    line for that operand and ``Permission denied``, the reason riding
    the record; without it the reason is the diagnostic,
    ``<cmd>: <reason>`` (a built-in that words a POSIX error, as
    ``rm: cannot remove 'x': ...`` does). The exit code and errno
    derive from the plane and this scope, never from a number a policy
    picks, so a document deny and a coded one are indistinguishable.
    """

    COMMAND = "command"
    OPERAND = "operand"


class Outcome(StrEnum):
    """What the profile's rules say about one line: the document's own
    three verbs and nothing else.

    ALLOW is silence as well as consent, since a line no rule speaks
    about runs. DENY covers both refusals, and ``Ruling.rule`` tells
    them apart: a rule refused it, or, with no rule, the allow list did.
    Both exit 126 and print the same line; the ``refusal`` record
    carries the operator's reason when there is one.
    """

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


@dataclass(frozen=True, slots=True)
class Deny:
    """Refuse the command, op or session write, with a reason.

    Rendered by the entry point it fires at: the command plane prints it in
    the scope's voice (DenyScope), the dispatcher raise EACCES with it,
    the session view EACCES too.

    Args:
        reason (str): why, without the command name and without a
            trailing newline; the entry point adds both.
        scope (DenyScope): whole command or one operand; ignored off
            the command plane.
        policy (str): the class name of the policy that spoke,
            stamped by the chain so no policy names itself.
        failed (bool): True when the chain refused on a policy's
            behalf because it raised.
        error (OSError | None): an op refusal with a specific errno; None
            uses the normal permission-denied error.
        path (str | None): the operand an OPERAND refusal is about, as
            typed: the entry point prints the command's own line for it and
            ``Permission denied``, the reason riding the record. None
            leaves the reason as the diagnostic.
        rule (CommandRule | None): the profile rule that refused, as an
            Ask carries the rule that asked; None for a coded condition.
    """

    kind: ClassVar[str] = "deny"

    reason: str
    scope: DenyScope = DenyScope.COMMAND
    policy: str = ""
    failed: bool = False
    error: OSError | None = None
    path: str | None = None
    rule: "CommandRule | None" = None


@dataclass(frozen=True, slots=True)
class Hide:
    """Answer as though the path did not exist.

    Outranks every other answer: a hidden path is absent, so there is
    nothing left to allow, refuse or ask about. Never rendered as a
    refusal: no reason, no ``refusal`` record, no explain line. The
    entry point raises ``error`` as the terminal would for a missing name
    (ENOENT, or EACCES for a create landing in a visible directory). The
    built-in hide answers it; no coded hook returns one.

    Args:
        error (OSError): what the entry point raises.
    """

    kind: ClassVar[str] = "hide"

    error: OSError


@dataclass(frozen=True, slots=True)
class Route:
    """Place a line on a runtime, the answer ``pre_execute`` gives
    beside a Deny.

    The runtime serves every command it captures on the line, as a
    ``route_policy`` verdict naming it does. A Deny at the stage
    outranks it, and two policies placing one line on different
    runtimes refuse the line, since neither choice is the line's.

    Args:
        runtime (str): the runtime entry's name.
        policy (str): the policy that placed the line; the chain fills
            it in.
    """

    kind: ClassVar[str] = "route"

    runtime: str
    policy: str = ""


@dataclass(frozen=True, slots=True)
class CommandRule:
    """One admission rule of the permissions document: refuse (or ask
    about) matching commands, on matching paths when it names any.

    It is the compiled element of ``commands.deny`` and ``commands.ask``
    wherever the profile writes one, and reaches the workspace only inside
    that document; the internal RulePolicy is what evaluates it. The
    document writes a rule in one of three shapes, and each compiles to
    rules of this class: a list of command patterns (a whole-line rule
    on each, no paths), a mapping of command pattern to its paths (one
    command to many paths, one rule per command, so a path is never
    stated beside a command it was not meant for), or paths alone (a
    rule on every command, at the dispatcher too). A command entry is a
    token-prefix pattern over the line as the entry point normalizes it (``rm``
    is every rm line, ``git push`` every ``git push ...``, a ``*`` token
    any one token). Path entries use the document's one grammar: an
    entry with ``*``, ``?`` or ``[`` is a pattern (repo fnmatch dialect,
    ``*`` crossing ``/``, a slashless pattern matching any name
    component), anything else is an exact path and its subtree. Every
    entry is absolute or a name pattern, holds a token (a blank one
    would be the root), and inside a mount section must name something
    under that mount root.

    Args:
        reason (str): why the command is refused, carried on the
            result's refusal record.
        commands (tuple[str, ...]): command patterns the rule applies
            to; empty means every command. A path-scoped rule carries
            exactly one.
        paths (tuple[str, ...]): path entries; empty refuses the
            command regardless of its operands.
        mount (str): set by the compiler for a rule written under a
            ``mounts.<prefix>`` section, the mount root it is scoped to:
            it applies only to a line whose cwd or paths lie under it.
            Empty for a rule written at the top level; never typed in
            the document.
    """

    reason: str
    commands: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()
    mount: str = ""


@dataclass(frozen=True, slots=True)
class HideReason:
    """Why one group of hide entries exists, for the operator only.

    The document may state a hide as ``{patterns: [...], reason: ...}``;
    the patterns compile into the flat hide spec like any other entry,
    and this side table keeps the reason beside them for the host's
    entry points (audit, read-back). It is never rendered to the agent: a hide
    answers ENOENT, and a reason on a nonexistent path would confirm
    the path exists.

    Args:
        patterns (tuple[str, ...]): the group's entries, as compiled
            (a mount section's entries anchored to its root).
        reason (str): why the operator hid them.
    """

    patterns: tuple[str, ...]
    reason: str


@dataclass(frozen=True, slots=True)
class Ruling:
    """The profile's answer about one line, and what produced it.

    Args:
        outcome (Outcome): which verb spoke.
        rule (CommandRule | None): the rule that spoke; None on ALLOW,
            and on the DENY the allow list produces, which is not a
            rule and so has no reason of its own to print.
        matched_path (str | None): the operand a path-scoped rule
            matched, as typed, which the GNU line names
            (``rm: cannot remove 'letters.txt': Permission denied``);
            None when the rule reaches the whole line.
        source (str): where in the document the rule was written, for a
            host reading a decision: ``top`` or ``mounts./repo``. Empty
            on ALLOW, and ``commands.allow`` on the DENY the allow list
            produces, which is the one place a source names no rule.
        asks (tuple[CommandRule, ...]): every ask that won at a subject
            of its own, ``rule`` among them, in the order the subjects
            were read. Only ASK fills it, and the line runs only once
            each has been answered: one nod covers the subject it was
            given for and no other, so a deeper ask on a destination
            cannot carry a source past the ask written for it. One
            entry is the ordinary case.
    """

    outcome: Outcome
    rule: CommandRule | None = None
    matched_path: str | None = None
    source: str = ""
    asks: tuple[CommandRule, ...] = ()


@dataclass(frozen=True, slots=True)
class Ask:
    """Admit the command only with a host approval.

    A pre_command answer: ``PermissionsPolicy`` returns one for a
    ``commands.ask`` rule, a custom policy for a coded condition, and
    both route to the workspace's decision ledger (``Decisions``). A Deny
    from any policy outranks it: the chain keeps looking past an Ask
    for a Deny, so an approval can never re-open a refusal. A pre_vfs
    answer too, where the entry point puts it to the ledger when no line is
    running behind the op and refuses it inside one.

    Args:
        reason (str): why the line needs sign-off, shown to the agent
            in the requires-approval voice and to the host in the
            request.
        rule (CommandRule | None): the document rule that asked; None
            for a coded condition, for which the ledger keys a session
            answer on the program that asked.
        rules (tuple[CommandRule, ...]): every rule the line has to be
            granted, ``rule`` among them and usually alone: a line whose
            operands were each asked about by a different rule carries
            them all. The entry point asks about them one at a time and runs
            the line only once each is answered, so a nod given for one
            operand cannot carry another. Empty for a coded Ask, whose
            one rule the entry point synthesizes.
        policy (str): the policy that asked, as ``explain`` names it.
    """

    kind: ClassVar[str] = "ask"

    reason: str
    rule: CommandRule | None = None
    rules: tuple[CommandRule, ...] = ()
    policy: str = ""


# The closed vocabulary of policy answers, ranked by kind: Hide (the
# built-in's, the path is absent), then Deny (first opinion wins), then
# Ask (defers to the host; a Deny anywhere in the chain still wins), then
# Route and Limit (every Route has to agree; every Limit merges to the
# tightest, Limit.aggr). A hook returns an Action to state an opinion or
# None to stay silent; each hook accepts a fixed set of kinds
# (VALIDITY), enforced loud.
Action = Hide | Deny | Limit | Ask | Route


class Scope(StrEnum):
    """How far an answer reaches.

    ONCE answers the one line that asked and is consumed by it, so the
    next identical line asks again. SESSION answers every line the same
    rule covers for the rest of the session. Nothing reaches further:
    an answer is never inherited by another session, and never
    re-opens a deny rule, which is consulted first.
    """

    ONCE = "once"
    SESSION = "session"


@dataclass(frozen=True, slots=True)
class Decision:
    """One asked line, and the answer to it once a host gives one.

    The ledger's entry, and the only shape the permissions layer keeps
    about an ask. It is written when a rule asks and rewritten when a
    host answers, so listing what is waiting and reading what was
    settled are the same query over the same records rather than two
    stores that can disagree.

    A retry is matched by comparing ``command``, ``argv`` and ``cwd``
    against what was recorded, not by re-deriving an id, so two lines
    that differ only where the recorded fields differ can never collide.

    Args:
        id (str): names this record, for a host to answer it by.
        session_id (str): the session running the line.
        agent_id (str): the agent the workspace attributes the line to.
        command (str): the command name.
        argv (tuple[str, ...]): the words after the name, as expanded.
        cwd (str): the session working directory.
        paths (tuple[str, ...]): the virtual paths the line names.
        reason (str): the ask's reason, as the rule worded it.
        rule (CommandRule): the rule that asked, synthesized for a
            coded Ask.
        outcome (Outcome | None): the host's answer, ALLOW or DENY;
            None while nobody has answered. ASK is not an answer, it is
            the question.
        scope (Scope): how far the answer reaches.
        note (str): what the host said when answering, if anything.
    """

    id: str
    session_id: str
    agent_id: str
    command: str
    argv: tuple[str, ...]
    cwd: str
    paths: tuple[str, ...]
    reason: str
    rule: CommandRule
    outcome: Outcome | None = None
    scope: Scope = Scope.ONCE
    note: str = ""


@dataclass(frozen=True, slots=True)
class Occurrence:
    """Where one command stands: the text it was parsed from, its span
    in that text, and the occurrence of the node that text was evaluated
    from, so the commands of a nested line stand under the word that
    ran them.

    The pass computes one from the line's parse and the gate from the
    node it runs, by one rule (``workspace/node/occurrence``), and the
    ledger only compares them: a grant a pass claims is bound to the
    occurrence it judged, and offered to a reader at that occurrence
    alone. So a word that expands at run time into the same command as
    a literal spelling elsewhere on the line (``$S && cat secret``)
    cannot run on the literal's nod, and one body evaluated under two
    words (``eval 'cat s'; eval 'cat s'``) is two occurrences.

    Args:
        parent (Occurrence | None): the node whose text this command
            was parsed from, None for a typed line.
        source (str): the text the command was parsed from.
        start (int): the command's first byte in that text.
        end (int): the byte after its last.
    """

    parent: "Occurrence | None"
    source: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Claim:
    """One grant a reader of a line matched, and the occurrence it
    matched it for.

    Args:
        occurrence (Occurrence): the command the grant answers.
        decision (Decision): the settled ONCE record.
    """

    occurrence: Occurrence
    decision: Decision


@dataclass(eq=False, slots=True)
class HandOff:
    """The ONCE grants a line's readers matched to its commands, for the
    line's end to spend.

    One per line, made by the executor and filled by ``Decisions.resolve``
    as a pass or a gate admits a command: every grant it matches, whether
    the host gave it inline just now or out of band before the line, is
    claimed here instead of spent, bound to the occurrence it was
    judged for. A claimed grant is on offer to that occurrence alone,
    so two spellings of one command on a line each need a nod of their
    own, and invisible to every other line of the session while this
    one lives, so two lines judged at once cannot both run on one nod.
    Nothing spends a claim while the line runs: a gate the run reaches
    again at the same place (a loop body) runs on the same nod, and
    every claim, reached or not, is spent when the line ends
    (``Decisions.revoke``). A background job the line launches holds a
    copy of the claims made for the commands inside it on a hand-off
    of its own (``Decisions.split``), since its gates run after the
    line has returned and it ends on its own clock; a grant is spent
    when the last hand-off holding it ends. Compared by identity,
    because the hand-off is the line.

    A line the executor evaluates from inside another (``$( )``,
    ``eval``, ``source``, ``xargs``, the line an alias invocation
    rewrites to) is a line of its own with a hand-off of its own,
    linked to the outer line's through ``parent`` and standing under
    the node that ran it through ``origin``: the outer pass reads into
    the words it runs, so the grants it claimed for them are the inner
    line's to run on, at the occurrences the outer pass computed for
    them, and what the inner line's own gates claim is handed to the
    outer line when it ends (``Decisions.hand_up``), for the next
    evaluation from the same node to run on and the typed line's end
    to spend.

    Args:
        claimed (list[Claim]): the grants matched so far, in the order
            the commands were judged.
        parent (HandOff | None): the hand-off of the line this one was
            evaluated from, None for a typed line.
        origin (Occurrence | None): the node this line's text was
            evaluated from, None for a typed line.
    """

    claimed: list[Claim] = field(default_factory=list)
    parent: "HandOff | None" = None
    origin: Occurrence | None = None


@dataclass(frozen=True, slots=True)
class Claimant:
    """Who reads the ledger: one command of one line.

    A judging pass and the gate that runs the line name themselves the
    same way, so a grant the pass claimed for a command is found by the
    gate for that command and by no other reader.

    Args:
        line (HandOff): the line's hand-off.
        occurrence (Occurrence): the command's place on it.
    """

    line: HandOff
    occurrence: Occurrence


@dataclass(frozen=True, slots=True)
class Pending:
    """The entry point's answer while the host has not decided: the line is
    refused for now, and the id names what to grant.

    Args:
        id (str): the approval id the agent should quote.
        reason (str): the ask's reason.
    """

    id: str
    reason: str


@dataclass(frozen=True, slots=True)
class Abandoned:
    """The question was abandoned: the run that raised it was killed
    while the host was still deciding, so the ledger stopped waiting.

    The record is left waiting, and whatever the host eventually answers
    is dropped rather than recorded — an answer banked against a run
    that no longer exists would be taken by the next identical line with
    nobody asked. The entry point turns this into the same abort every other
    killed wait raises; the ledger states the fact in its own vocabulary
    because execution is not its to know about.
    """


class SessionDecisionsQuery(Protocol):
    """The session questions the decision ledger asks.

    The SessionManager satisfies it structurally, so the ledger reads
    and writes a session's records by id without this package importing
    the workspace, and always on the registered session rather than the
    fork a line may be running in.
    """

    def decision_sessions(self) -> tuple[str, ...]:
        """Every session id holding records, oldest first."""
        ...

    def decisions_of(self, session_id: str) -> tuple[Decision, ...]:
        """The records a session holds, oldest first.

        Args:
            session_id (str): the session.
        """
        ...

    def set_decisions(
        self, session_id: str, records: tuple[Decision, ...]
    ) -> None:
        """Replace a session's records.

        Args:
            session_id (str): the session.
            records (tuple[Decision, ...]): the new list.
        """
        ...

    async def flush(self) -> None:
        """Persist what changed."""
        ...


@dataclass(frozen=True, slots=True)
class AdmissionRules:
    """One profile's admission rules, compiled: the whole permission
    document a session runs under.

    A session is evaluated against exactly one of these. It holds the
    profile's allow list, its ask and deny rules, and the rules its mount
    entries carry, each stamped with the mount it was written under so
    it applies to a line working inside that mount. There is nothing
    above it and nothing beside it: two rules that both match are
    resolved by anchor depth, then by verb (``policy/match/decide``).

    Args:
        allow (tuple[str, ...] | None): the profile's allow patterns; None
            when it states no list (everything visible).
        ask (tuple[CommandRule, ...]): rules admitted only with an
            approval.
        deny (tuple[CommandRule, ...]): rules refused with a reason.
    """

    allow: tuple[str, ...] | None = None
    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()


# The rules that apply to one line, each with the verb it carries, deny
# before ask and in the order written. Built once per line by ``decide``
# and read again at every subject of it.
LiveRules = Sequence[tuple[Outcome, CommandRule]]


@dataclass(frozen=True, slots=True)
class ProfileScript:
    """One profile's script, as a session carries it: the program, the
    engine it runs on, and the profile it speaks for.

    Compiled off ``SessionProfile.policy`` beside the admission rules,
    and evaluated by ``ScriptPolicy`` at the admission hooks the program
    defines (``pre_command``, ``pre_vfs``, ``pre_session``) with the
    entry point's facts as ``ctx``; its answer is allow (no opinion), deny, or
    at the command gate ask.

    Args:
        profile (str): the profile's name, which the script reads as
            ``ctx["profile"]`` and every refusal about it prints; empty
            for a profile document passed to ``create_session`` without
            a name.
        script (ScriptSource): the program, as the config loader loaded
            it.
        runtime (str): the engine the profile named for it.
    """

    profile: str
    script: ScriptSource
    runtime: str


class SessionCommandsQuery(Protocol):
    """The one session question the permissions policy asks.

    The SessionManager satisfies it structurally, so the policy reads
    the layers by session id without this package importing the
    workspace.
    """

    def commands_of(self, session_id: str) -> "AdmissionRules | None":
        """The compiled admission rules of one session; the default
        profile's for an id the manager does not know, the empty id of an
        unbound entry point included.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        ...


class SessionScriptsQuery(Protocol):
    """The one session question the script policy asks.

    The SessionManager satisfies it structurally, the same way it
    satisfies ``SessionCommandsQuery``, so the policy reads a session's
    script by the id the entry point put in the context.
    """

    def script_of(self, session_id: str) -> "ProfileScript | None":
        """The script of the profile one session runs under; the
        default profile's for an id the manager does not know, None for
        a profile that states none.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        ...


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Facts about one classified command, as pre_command hooks see it.

    Args:
        command (str): the command name.
        paths (tuple[PathSpec, ...]): every path the line names, the
            positional operands first and then the values of any
            path-valued flags. What a path-pattern guard matches on.
        operands (tuple[PathSpec, ...]): the positional operands alone.
            A rule that reads a slot by position (mv's source, ln's
            target, tar's files) has to use this: with the flag values
            mixed in, ``tar -xf a.tar -C /mnt`` would read the ``-C``
            destination as a file being archived.
        argv (tuple[str, ...]): raw argv after the command name; the
            hook fires before flag parsing, so shorthand flags are raw
            tokens.
        cwd (str): session working directory.
        registry (MountRootQuery): mount-root oracle for POSIX rules.
        session_id (str): the session running the line, set by the
            entry point; empty outside a workspace.
        agent_id (str): the agent the workspace attributes the line
            to, carried per execution so a nested line (``eval``,
            ``$()``, ``xargs``) and a concurrent one keep their own;
            what an approval request names.
        tokens (tuple[str, ...]): the line as an admission pattern
            reads it, command name first: for an installed CLI the
            verb path replaces the words before it (options before the
            verb dropped, an alias canonicalized), then the leaf's own
            words; for anything else the name and the raw argv.
        program (tuple[str, ...]): the head of ``tokens`` that names
            what runs: the name plus a CLI's verb path.
        tool (bool): whether the word is a tool the allow lists govern,
            which every named command is, shell builtins included. The
            entry point clears it for the agent's own function where the
            function is what runs, and for an executed path: neither is
            a name a list could hold, and every line either runs passes
            the gate itself, so an allow list never refuses them,
            though a deny rule still can.
        walks (bool): whether the command descends its directory
            operands (``find``, ``du``, ``tree``, ``rg``, ``grep -r``,
            ``ls -R``), so a mount whose root sits under one of its
            paths is a mount the line works inside: the executor's
            fan-out reruns the traversal in each descendant mount, and
            no admission fires again there.
    """

    command: str
    paths: tuple[PathSpec, ...]
    argv: tuple[str, ...]
    cwd: str
    registry: MountRootQuery
    operands: tuple[PathSpec, ...] = ()
    session_id: str = ""
    agent_id: str = ""
    tokens: tuple[str, ...] = ()
    program: tuple[str, ...] = ()
    tool: bool = True
    walks: bool = False


@dataclass(frozen=True, slots=True)
class VfsContext:
    """Facts about one VFS op, as pre_vfs hooks see it.

    Fires at the dispatcher (the ``ws.vfs`` facade, which also serves
    FUSE, and the shell's internal dispatcher), before any backend or
    cache I/O, so it holds however the mount is reached.

    Args:
        op (str): operation name (read, write, unlink, readdir, ...).
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the dispatcher serves, set by the entry
            point from the session it already resolves for hides and modes;
            empty for the unbound host view.
        mode (MountMode | None): the owning mount's authorization ceiling,
            None at an entry point that judges the mode itself.
        create (bool): the op creates this path.
        subtree (bool): the op mutates the path's descendants too.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    session_id: str = ""
    mode: MountMode | None = None
    create: bool = False
    subtree: bool = False


@dataclass(frozen=True, slots=True)
class VfsResultContext:
    """One completed VFS op, as post_vfs hooks see it.

    Args:
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result (bytes, FileStat, listing,
            ...); a Deny here suppresses it.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    result: Any


@dataclass(frozen=True, slots=True)
class ExecuteResultContext:
    """One finished execute() line, as post_execute hooks see it.

    Fires at the workspace boundary before the line's output stream is
    finalized, so a Limit returned here bounds what the caller sees.

    Args:
        producer (Producer): provenance of the surviving stream (the
            rightmost command, per shell semantics); a Producer with an
            empty command when no dispatch site stamped one.
        exit_code (int): the line's exit code so far.
    """

    producer: Producer
    exit_code: int


@dataclass(frozen=True, slots=True)
class SessionContext:
    """Facts about one session-state mutation, as pre_session hooks see it.

    Fires on the session plane before the write lands, so it holds
    whichever tier asked. Not an VfsContext: a session key is not a
    path, and a path-scoped policy must never receive one dressed as a
    path and match it by accident.

    Args:
        plane (str): the state plane being written (``env``).
        verb (str): the mutation (``set``, ``unset``).
        key (str): the state key (a variable name).
        value (str | None): the value being written, None for unset.
        session_id (str): which session is writing, so a policy can
            scope a rule to one agent (deny ``set`` for session X).
    """

    plane: str
    verb: str
    key: str
    value: str | None
    session_id: str = ""


VALIDITY: dict[str, frozenset[str]] = {
    "pre_command": frozenset({Deny.kind, Ask.kind}),
    "pre_execute": frozenset({Deny.kind, Route.kind}),
    "pre_vfs": frozenset({Deny.kind, Ask.kind}),
    "post_vfs": frozenset({Deny.kind, Limit.kind}),
    "post_execute": frozenset({Limit.kind}),
    "pre_session": frozenset({Deny.kind}),
}


class DryRun(StrEnum):
    """What a dry run's calls are while the policies decide the op it
    explains.

    DECIDING is a policy's own ops: a read runs for real, a refusal
    raises the entry point's error with no question recorded, and a write is
    refused as on a read-only mount, so an explanation changes nothing.
    """

    DECIDING = "deciding"


@dataclass(frozen=True, slots=True, kw_only=True)
class Explanation:
    """What the policies decide about one thing a session would do,
    without doing it: the verdict every explanation carries.

    Produced by the same gates the dispatcher runs, so a host reading
    one and an agent running the call cannot be told different things.
    A line (:class:`ShellExplanation`), each of its commands
    (:class:`CommandExplanation`) and a VFS call
    (:class:`VfsExplanation`) extend it with what is theirs; ``answers``
    holds what the hook judging that level said.

    Args:
        outcome (Outcome): ``ALLOW``, ``DENY`` or ``ASK`` (an ask an
            approval already covers stays ``ASK`` with no refusal).
        reason (str): why, in the deciding policy's words; empty when
            nothing refuses or asks.
        source (str): where in the profile the deciding rule is written
            (``top``, ``mounts./runbook``, ``commands.allow`` for the
            allow list); empty when no rule decided.
        answers (tuple[Deny | Ask | Route, ...]): every policy's answer,
            in the order the chain asks them, each naming its policy;
            the profile's rules answer as ``PermissionsPolicy``. A hide
            is never among them.
        refusal (Refusal | None): the record a refused run carries,
            None when it would run.
    """

    outcome: Outcome = Outcome.ALLOW
    reason: str = ""
    source: str = ""
    answers: "tuple[Deny | Ask | Route, ...]" = ()
    refusal: Refusal | None = None


@dataclass(frozen=True, slots=True)
class ShellOperand:
    """One path argument of a command, as the rules read it.

    A path the session cannot see is listed like any path no rule
    matches: ``path`` is resolved from the cwd alone, links unfollowed,
    so it names nothing the session could not type.

    Args:
        text (str): the argument as typed.
        path (str): the absolute path it names.
        matched (bool): whether the deciding rule matched it.
    """

    text: str
    path: str
    matched: bool = False


@dataclass(frozen=True, slots=True)
class ShellNode:
    """One piece of a line's structure, as the shell parses it.

    Args:
        type (str): ``list`` (``;`` ``&&`` ``||`` ``&``), ``pipeline``,
            ``subshell``, ``group`` (braces and the bodies of ``if``,
            ``for``, ``while``, ``case`` and functions), ``line`` (a line
            a command runs: ``bash -c``, ``eval``, ``xargs``) or
            ``substitution`` (``$( )``, backticks, ``<( )``).
        text (str): the node's source text.
        children (tuple[ShellNode | CommandExplanation, ...]): what it
            holds, in source order.
    """

    type: str
    text: str
    children: "tuple[ShellNode | CommandExplanation, ...]" = ()


@dataclass(frozen=True, slots=True, kw_only=True)
class CommandExplanation(Explanation):
    """One command of a line, explained: whether it may run (its
    ``pre_command`` answers) and where it would run.

    Args:
        answers (tuple[Deny | Ask, ...]): every policy's answer to the
            command (``pre_command``).
        command (str): the program, as the gate read it.
        argv (tuple[str, ...]): the words after it.
        exit_code (int): what the command would exit with where it
            stands, 0 to run.
        stderr (str): what the agent would read from it, empty to run.
        runtime (str): the runtime entry that would run it, empty when
            the workspace runs it itself.
        operands (tuple[ShellOperand, ...]): its path arguments,
            redirect targets included.
        text (str): the command's source text.
        children (tuple[ShellNode, ...]): the lines it runs in turn
            (``$( )`` in its words, a ``bash -c`` string), in source
            order.
    """

    type: ClassVar[str] = "command"

    answers: "tuple[Deny | Ask, ...]" = ()
    command: str
    argv: tuple[str, ...] = ()
    exit_code: int = 0
    stderr: str = ""
    runtime: str = ""
    operands: tuple[ShellOperand, ...] = ()
    text: str = ""
    children: tuple[ShellNode, ...] = ()


@dataclass(frozen=True, slots=True, kw_only=True)
class ShellExplanation(Explanation):
    """A line, explained: what the agent would read, where the line
    would run (its ``pre_execute`` answers) and every command in it.

    The verdict is whether the line runs at all: a rule's refusal, or a
    question still waiting on the host, refuses the whole line before
    any of it runs, as does a placement's refusal; the first in the
    order the gate reads them is the line's, byte-identical to the
    refusal the run reports. A line that runs exits 0 here, and one an
    approval lets run carries the ask it covers. A command refused
    where it stands while the rest of the line runs (a word the session
    cannot see, a policy refusing one operand) says so on its own node.

    Args:
        answers (tuple[Deny | Route, ...]): every policy's answer to
            where the line runs (``pre_execute``), the route policy's
            first; empty when nothing places it or a command refuses it
            first.
        line (str): the line as given.
        exit_code (int): what the line is refused with, 0 when it runs.
        stderr (str): what the agent would read then, empty when it
            runs.
        node (ShellNode): the parsed line, of type ``line``.
    """

    answers: "tuple[Deny | Route, ...]" = ()
    line: str
    exit_code: int = 0
    stderr: str = ""
    node: ShellNode


@dataclass(frozen=True, slots=True, kw_only=True)
class VfsExplanation(Explanation):
    """A VFS call, explained: the POSIX-shaped call on ``session.vfs``
    (``read``, ``pwrite``, ``rename``, ``setxattr``, ...) and what its
    gate (``pre_vfs``) would answer.

    Args:
        answers (tuple[Deny | Ask, ...]): every policy's answer to the
            call (``pre_vfs``).
        call (str): the call's name.
        paths (tuple[str, ...]): its path arguments, as given.
        error (str): the errno name the call would raise (``EACCES``,
            ``EROFS``), empty when it would run.
    """

    answers: "tuple[Deny | Ask, ...]" = ()
    call: str
    paths: tuple[str, ...] = ()
    error: str = ""


class EntryGate(Protocol):
    """What a command's own I/O asks before touching an entry it
    reached below its operands.

    The admission gate judges the paths a line names; a walk (``grep
    -r``, ``find``, ``du``, ``cp -r``, ``tar``) then reaches entries no
    rule has seen. The dispatcher binds the admitted command's gate to
    the session context for the command's run, and the commands tier
    reads it there, so the tier that enforces the rules never imports
    the tier that states them.

    Args:
        scoped (bool): whether a path rule in force reads this command's
            paths at all, or a coded or scripted pre_vfs policy speaks
            for its session; a native walk (a backend's own find or du)
            yields to the guarded readdir walk while it is set, so each
            entry passes the gate.
        granted (tuple[CommandRule, ...]): the ask rules this line runs
            under a grant for. Read by the dispatcher, which see the same
            entries from below and would otherwise re-derive a verdict
            that knows nothing of the nod the gate already took.
    """

    @property
    def scoped(self) -> bool: ...

    @property
    def granted(self) -> tuple[CommandRule, ...]: ...

    def scopes(self, virtual: str) -> bool:
        """Whether anything at or under this path could be refused for
        the running command, so a native walk there gives way to the
        guarded one; per operand, unlike ``scoped``.

        Args:
            virtual (str): absolute virtual path of a walk's start point.
        """
        ...

    def check(self, virtual: str) -> None:
        """Raise when a rule in force refuses this entry for the running
        command; return when the command may touch it.

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        ...

    def refuses(self, virtual: str) -> bool:
        """True exactly where ``check`` would raise, for an entry point that
        declines instead (the read cache).

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        ...

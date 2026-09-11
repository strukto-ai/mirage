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
from mirage.types import Limit, PathSpec, Producer, Refusal


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool:
        ...


class DenyScope(StrEnum):
    """What a command-plane refusal is about, which picks its voice.

    COMMAND refuses the whole line in bash's own words,
    ``<cmd>: Permission denied``, exit 126, and the reason rides the
    result's ``refusal`` record instead. OPERAND refuses one operand
    and keeps the GNU voice
    ``<cmd>: <reason>`` (the reason names the operand, as
    ``rm: cannot remove 'x': ...`` does), exit 1, or the command's own
    fatal code where GNU differs (tar exits 2). The exit code and errno
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

    Rendered by the door it fires at: the command plane prints it in
    the scope's voice (DenyScope), the op doors raise EACCES with it,
    the session door EACCES too.

    Args:
        reason (str): why, without the command name and without a
            trailing newline; the door adds both.
        scope (DenyScope): whole command or one operand; ignored off
            the command plane.
        policy (str): the class name of the policy that spoke,
            stamped by the chain so no policy names itself.
        failed (bool): True when the chain refused on a policy's
            behalf because it raised.
    """

    kind: ClassVar[str] = "deny"

    reason: str
    scope: DenyScope = DenyScope.COMMAND
    policy: str = ""
    failed: bool = False


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
    rule on every command, at the op door too). A command entry is a
    token-prefix pattern over the line as the door normalizes it (``rm``
    is every rm line, ``git push`` every ``git push ...``, a ``*`` token
    any one token). Path entries use the document's one grammar: an
    entry with ``*``, ``?`` or ``[`` is a pattern (repo fnmatch dialect,
    ``*`` crossing ``/``, a slashless pattern matching any name
    component), anything else is an exact path and its subtree. Every
    entry is absolute or a name pattern, holds a token (a blank one
    would be the root), and inside a mount section must name something
    under that mount root.

    Args:
        reason (str): why the command is refused, shown on stderr.
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
    doors (audit, read-back). It is never rendered to the agent: a hide
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
            matched, as typed, which the GNU voice prints
            (``rm: letters.txt: <reason>``); None when the rule reaches
            the whole line.
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
    for a Deny, so an approval can never re-open a refusal. Command
    plane only: the op doors cannot wait on a host.

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
            them all. The door asks about them one at a time and runs
            the line only once each is answered, so a nod given for one
            operand cannot carry another. Empty for a coded Ask, whose
            one rule the door synthesizes.
    """

    kind: ClassVar[str] = "ask"

    reason: str
    rule: CommandRule | None = None
    rules: tuple[CommandRule, ...] = ()


# The closed vocabulary of policy answers: a hook returns an Action to
# state an opinion or None to stay silent. Deny refuses (first opinion
# wins); Ask defers to the host (a Deny anywhere in the chain still
# wins); Limit bounds (every opinion merges to the tightest,
# Limit.aggr). Each hook accepts a fixed set of kinds (VALIDITY),
# enforced loud.
Action = Deny | Limit | Ask


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
    """The door's answer while the host has not decided: the line is
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
    nobody asked. The door turns this into the same abort every other
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

    def set_decisions(self, session_id: str, records: tuple[Decision,
                                                            ...]) -> None:
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
    defines (``pre_command``, ``pre_ops``, ``pre_session``) with the
    door's facts as ``ctx``; its answer is allow (no opinion), deny, or
    at the command gate ask.

    Args:
        profile (str): the profile's name, which the script reads as
            ``ctx["profile"]`` and every refusal about it prints; empty
            for a profile document passed to ``create_session`` without
            a name.
        script (ScriptSource): the program, as the config door loaded
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
        unbound door included.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        ...


class SessionScriptsQuery(Protocol):
    """The one session question the script policy asks.

    The SessionManager satisfies it structurally, the same way it
    satisfies ``SessionCommandsQuery``, so the policy reads a session's
    script by the id the door put in the context.
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
            door; empty outside a workspace.
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
            door clears it for the agent's own function where the
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
class OpsContext:
    """Facts about one VFS op, as pre_ops hooks see it.

    Fires at the op doors (the ``ws.fs`` facade, which also serves
    FUSE, and the shell's internal dispatcher), before any backend or
    cache I/O, so it holds however the mount is reached.

    Args:
        op (str): operation name (read, write, unlink, readdir, ...).
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the door serves, set by the door
            from the session it already resolves for hides and modes;
            empty for the unbound host view.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    session_id: str = ""


@dataclass(frozen=True, slots=True)
class OpsResultContext:
    """One completed VFS op, as post_ops hooks see it.

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
    whichever tier asked. Not an OpsContext: a session key is not a
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
    "pre_ops": frozenset({Deny.kind}),
    "post_ops": frozenset({Deny.kind, Limit.kind}),
    "post_execute": frozenset({Limit.kind}),
    "pre_session": frozenset({Deny.kind}),
}


@dataclass(frozen=True, slots=True)
class Explanation:
    """What one command of a line would do, without doing it.

    Produced by the same gate the dispatcher runs, so a host reading
    this and an agent typing the line cannot be told different things.
    Everything the agent would see is here as it would arrive:
    ``exit_code`` and ``stderr`` come out of the one outcome table, so
    an explanation of a refused line is byte-identical to the refusal.

    ``outcome`` is the document's answer and ``rule`` says who gave it.
    The two refusals the allow list produces both arrive as ``DENY``
    with no rule, and ``exit_code`` separates them: 127 for a head word
    the session cannot see, which reads as bash's "command not found"
    so an unlisted tool never leaks that it exists, and 126 for a line
    whose head was visible but which no allow entry covers.

    Args:
        command (str): the head word, as the gate read it.
        argv (tuple[str, ...]): the words after it.
        outcome (Outcome): what the profile's rules say.
        rule (CommandRule | None): the rule that spoke, None when the
            allow list did or when nothing did.
        reason (str): the rule's reason, empty when there is no rule.
        source (str): where in the document the rule was written.
        matched_path (str | None): the operand a path-scoped rule
            matched, as typed.
        paths (tuple[str, ...]): the paths the rules were shown, after
            the session's hides dropped what it cannot see.
        exit_code (int): what the line would exit with, 0 to run.
        stderr (str): what the agent would read, empty to run.
        refusal (Refusal | None): the record the refused result
            would carry, None when the line would run.
    """

    command: str
    argv: tuple[str, ...] = ()
    outcome: Outcome = Outcome.ALLOW
    rule: CommandRule | None = None
    reason: str = ""
    source: str = ""
    matched_path: str | None = None
    paths: tuple[str, ...] = ()
    exit_code: int = 0
    stderr: str = ""
    refusal: Refusal | None = None

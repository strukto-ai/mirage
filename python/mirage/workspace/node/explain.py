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

import asyncio
import dataclasses
import re
from collections.abc import (
    AsyncIterator,
    Callable,
    Generator,
    Iterator,
    Mapping,
    Sequence,
)
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from mirage.context.session_context import current_caller, voice_name
from mirage.io.yield_budget import YieldBudget
from mirage.policy import (
    AdmissionRules,
    Ask,
    Claimant,
    CommandContext,
    CommandExplanation,
    CommandRule,
    CommandWord,
    Deny,
    HandOff,
    Occurrence,
    Pending,
    Route,
    ShellExplanation,
    ShellNode,
    decision_of,
    render_command_deny,
    render_deny,
)
from mirage.policy.builtin.permissions import PermissionsPolicy
from mirage.policy.decisions import is_pending
from mirage.policy.match import Outcome, has_rules, reads_args, scopes_paths
from mirage.policy.match.decide import source_of
from mirage.policy.policies import command_route, settled
from mirage.rs.session import ShellVars
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.helpers import (
    get_case_items,
    get_case_word,
    get_function_name,
    get_if_branches,
    get_parts,
    get_text,
    input_substitution_redirect,
    is_backgrounded,
    literal_word,
    split_env_prefix,
)
from mirage.shell.node_kind import (
    NodeKind,
    PipelineScope,
    ScopeKind,
    background_pipeline,
    connection_runs_right,
    node_kind,
    pipeline_stage_forks,
    scope_kind,
)
from mirage.shell.options import parse_option_word
from mirage.shell.parse import opaque_reads, parse, referenced_names
from mirage.shell.types import NodeType
from mirage.shell.variable import VarAttr
from mirage.types import PathSpec, PolicyDecision
from mirage.utils.hidden import is_glob
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.alias.alias import expanding_aliases
from mirage.workspace.executor.builtins.env.env import env_child, env_vars
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.lookup import line_facts
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import (
    Refused,
    admit_redirect,
    classified_words,
    gate,
    opened_by,
    redirect_asked,
    redirect_paths,
    redirect_refused,
    resolved,
    statement_redirects,
    statement_stdin,
    unowned_redirects,
)
from mirage.workspace.node.inner_lines import (
    HOOK_VARS,
    InnerLine,
    Word,
    inner_lines,
    is_hook,
    program_lines,
    read_word,
    reads_of_test,
    runs_function,
)
from mirage.workspace.node.occurrence import (
    Frame,
    argv_frame,
    body_frame,
    definition_frame,
    gate_frame,
    line_frame,
    occurrence_in,
    root_frame,
    segment_frames,
    whole_occurrence,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.shell_dirs import tilde_homes
from mirage.workspace.session.state import (
    env_is_readonly,
    env_snapshot,
    seed_var,
    set_attr,
)

# How the explanation tree names a parse node that shapes a line; a node
# not here (a redirected or negated statement) is read through.
SHAPES = {
    NodeType.LIST: "list",
    NodeType.PIPELINE: "pipeline",
    NodeType.SUBSHELL: "subshell",
    NodeType.COMPOUND_STATEMENT: "group",
    NodeType.IF_STATEMENT: "group",
    NodeType.FOR_STATEMENT: "group",
    NodeType.WHILE_STATEMENT: "group",
    NodeType.CASE_STATEMENT: "group",
    NodeType.FUNCTION_DEFINITION: "group",
}

# How strict an outcome is, for a line's summary: the strictest part of
# the line speaks for it.
STRICTNESS = {Outcome.ALLOW: 0, Outcome.ASK: 1, Outcome.DENY: 2}

# Nodes a list of statements holds that run nothing.
INERT = frozenset({"comment", "heredoc_body"})

# The nodes the shell may open a redirect for that no command owns
# (``opened_by``): a bare redirect, the statements a redirect binds to
# whole, and an assignment.
OPENERS = frozenset(
    {
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
    }
)

# The redirects a redirected statement carries after its body.
REDIRECT_TYPES = frozenset(
    {
        NodeType.FILE_REDIRECT,
        NodeType.HEREDOC_REDIRECT,
        NodeType.HERESTRING_REDIRECT,
    }
)

# Commands that move the shell's cwd where the walk cannot follow: a line
# run in this shell, and the directory stack.
CWD_MOVERS = frozenset({"eval", ".", "source", "pushd", "popd"})

# How many other places a line may stand in before the walk calls its cwd
# lost: each relative ``cd`` doubles them.
PLACES_LIMIT = 8


# Why the gate refuses, under a rule, a command that runs lines it cannot
# see into: a sourced file, a script, a bash option mirage does not read.
UNREADABLE_LINES = "runs lines the gate cannot read"
HOME_VAR = frozenset({"HOME"})
# Builtins that store into the variables they name, with their options
# that take a value.
_STORES = {
    "read": "adinNptu",
    "mapfile": "dnOsuCc",
    "readarray": "dnOsuCc",
    "getopts": "",
}
# The declarations whose `-n` makes a nameref (`export -n` unexports).
_NAMEREFS = frozenset({"declare", "typeset", "local"})
_DECLARES = _NAMEREFS | {"export", "readonly"}
# An unquoted `~` bash expands after an assignment-shaped word's `=` or `:`.
_ASSIGNED_TILDE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=(?:[^~'\"\\]*[:=])?~")


class JudgmentMode(StrEnum):
    """How a static judgment reads the policy chain and the command."""

    PREPASS = "prepass"
    EXPLAIN = "explain"
    WHOLE_LINE = "whole_line"
    EXPLAIN_WHOLE_LINE = "explain_whole_line"


def takes_whole_line(mode: JudgmentMode) -> bool:
    """Whether this is the gate for a runtime that expands its own line."""
    return mode in (JudgmentMode.WHOLE_LINE, JudgmentMode.EXPLAIN_WHOLE_LINE)


@dataclass(frozen=True, slots=True)
class Judgment:
    """What the gate decides about one command of a line, as the pass
    reads it: the per-command record ``explain`` and the admission pass
    share, which :func:`explained_line` turns into the public tree.

    ``outcome`` is the document's answer and ``rule`` says who gave it.
    A line a closed tree names nothing for arrives as ``DENY`` with the
    root's own leaf as its rule, at 126.

    Args:
        command (str): the head word, as the gate read it.
        argv (tuple[str, ...]): the words after it.
        outcome (Outcome): what the profile's rules say.
        rule (CommandRule | None): the leaf that spoke, None when a
            coded condition did or when nothing did.
        reason (str): the rule's reason, empty when there is no rule.
        source (str): where in the document the rule was written.
        matched_path (str | None): the file a redirect was refused for.
        paths (tuple[str, ...]): the paths the rules were shown, after
            the session's hides dropped what it cannot see.
        exit_code (int): what the line would exit with, 0 to run.
        stderr (str): what the agent would read, empty to run.
        decision (PolicyDecision | None): the record the refused result would
            carry, None when the line would run.
        answers (tuple[Deny | Ask | Route, ...]): every policy's answer
            to the command, in the order the chain asks them.
        words (tuple[CommandWord, ...]): the command line word by word,
            each with its kind and the path it names, redirect targets
            last.
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
    decision: PolicyDecision | None = None
    answers: tuple[Deny | Ask | Route, ...] = ()
    words: tuple[CommandWord, ...] = ()


def _denied(command: str, reason: str) -> Judgment:
    """The explanation of a command the gate refuses outright.

    Args:
        command (str): the command's name as typed.
        reason (str): why the gate refuses it.
    """
    deny = Deny(reason)
    err, code = render_deny(command, deny)
    return Judgment(
        command=command,
        outcome=Outcome.DENY,
        reason=reason,
        exit_code=code,
        stderr=decode_text(err),
        decision=decision_of(deny),
    )


def unreadable(raw: str) -> str:
    """Why the gate refuses a word only the runtime can expand.

    Args:
        raw (str): the word as typed.
    """
    return f"cannot read {raw} before the runtime expands it"


async def _explained(
    ctx: CommandContext,
    registry: MountRegistry,
    asked: Deny | Ask | None,
    answers: tuple[Deny | Ask | Route, ...],
) -> Judgment:
    """One command's explanation, read off the answers the gate's chain
    gave and rendered from the same table the gate renders a refusal
    with: the profile's rules (``PermissionsPolicy``) say the outcome
    and the rule that spoke, the chain's answer what the line would do.

    An Ask reads the session's standing grants and stops there
    (``Decisions.held``): a dry run must not spend one, record a
    question or reach the host. An answer that already covers the ask
    leaves the outcome ASK, because that is what the document says,
    with exit 0, because that is what the line would do.

    Args:
        ctx (CommandContext): the classified command.
        registry (MountRegistry): registry holding the decision ledger.
        asked (Deny | Ask | None): what the policy chain answered.
        answers (tuple[Deny | Ask | Route, ...]): the answers it came
            from.
    """
    document = settled(
        tuple(
            a
            for a in answers
            if isinstance(a, (Deny, Ask))
            and a.policy == PermissionsPolicy.__name__
        )
    )
    rule = document.rule if document is not None else None
    base = Judgment(
        command=ctx.command,
        argv=ctx.argv,
        outcome=(
            Outcome.DENY
            if isinstance(document, Deny)
            else Outcome.ASK
            if isinstance(document, Ask)
            else Outcome.ALLOW
        ),
        rule=rule,
        reason=document.reason if document is not None else "",
        source=(
            source_of(rule)
            if rule is not None
            else "commands"
            if document is not None
            else ""
        ),
        paths=tuple(p.virtual for p in ctx.paths),
        answers=answers,
    )
    action: Deny | Pending | None = (
        registry.decisions.held(ctx, asked)
        if isinstance(asked, Ask)
        else asked
    )
    if action is None:
        return base
    err, code = await render_command_deny(ctx.command, action, ctx)
    return dataclasses.replace(
        base,
        reason=action.reason if base.reason == "" else base.reason,
        exit_code=code,
        stderr=decode_text(err),
        decision=decision_of(action),
    )


@dataclass(frozen=True, slots=True)
class Judged:
    """One command's explanation and where the command stands.

    The occurrence is what the pass hands the ledger beside the
    explanation: a grant claimed for the command is bound to it, so
    the gate that runs the same occurrence finds it and no other
    reader does.

    Args:
        judgment (Judgment): what the command would do.
        occurrence (Occurrence): the command's place on the line.
        intrinsic (bool): a shell-provided operation with a tool policy.
        stated (bool): whether the gate will read the command in the
            words the pass read: every word literal, and no operand
            the runtime appends. The gate reads ``cat $F`` as the path
            ``$F`` expands to and ``xargs cat`` as ``cat`` plus the
            items on its stdin, so a question the pass asked about
            either spelling would be answered for words that never
            run, and the gate would ask again about the words that do.
            Such a command is judged here for a deny, which speaks on
            the name alone, and asked about at the gate.
        unread (frozenset[str]): the paths no policy was shown
            (``_unread_paths``), so a pass that asks the gate again asks
            about what this explanation judged.
        ctx (CommandContext | None): the context the chain was shown,
            None for a command refused before it, so ``explain`` can
            gather every policy's answer without the gate paying for it.
        session (SessionState | None): the session the command was
            judged in, set beside ``ctx``: for a command a line runs in
            turn (``eval``), the one its own walk reached, so a ``cd``
            before it in that line is where it stands.
    """

    judgment: Judgment
    occurrence: Occurrence
    stated: bool
    intrinsic: bool = False
    unread: frozenset[str] = frozenset()
    ctx: CommandContext | None = None
    session: SessionState | None = None


@dataclass(frozen=True, slots=True)
class Opened:
    """A redirect no command owns (``{ cat; } < f``, ``> f``), as the dry
    run judges it: what opening its target would do, and the statement
    it redirects.

    Args:
        judgment (Judgment): what the open would do, ``command`` empty.
        occurrence (Occurrence): where the redirected statement stands.
    """

    judgment: Judgment
    occurrence: Occurrence


@dataclass(frozen=True, slots=True)
class Traced:
    """What a line does as :func:`_line_status` follows it.

    Args:
        exit_code (int): what the line would return.
        ran (tuple[Judgment, ...]): the refusals it would print, in
            order.
        calls (frozenset[tuple[int, int, int]]): the judgments, by span
            and place among their span's, of the commands that call a
            function the shell has defined when they run.
        reached (frozenset[tuple[int, int, int]]): the judgments the
            fold reached, run or skipped.
        at (Mapping[int, frozenset[str]]): for each node the fold
            enters, by where it starts, the functions defined when it
            runs, which is what a line it runs in turn sees.
        bodies (Mapping[int, frozenset[str]]): for each definition the
            line runs, by where it starts, the functions defined at
            every command that calls it, which is what its body sees.
    """

    exit_code: int
    ran: tuple[Judgment, ...]
    calls: frozenset[tuple[int, int, int]]
    reached: frozenset[tuple[int, int, int]]
    at: Mapping[int, frozenset[str]]
    bodies: Mapping[int, frozenset[str]]


def _unread_paths(
    words: Sequence[Word],
    kinds: Sequence[str | PathSpec],
    cwd: str,
    lost: bool,
) -> frozenset[str]:
    """The paths a command's words may name that the pass cannot vouch
    for: what a word only the runtime expands names, and, once a ``cd``
    lost the cwd, the cwd and what every relative word names. Judged as
    typed in the cwd the pass last knew, a glob in a rule matched them
    and refused lines that touch only allowed files. A path some word
    names outright as a path stays read: ``rm -rf /data/old`` names
    ``/data/old`` even when that is the cwd a ``cd`` lost, while the
    pattern in ``grep -r -e /data/old`` names no path at all.

    Args:
        words (Sequence[Word]): the command's words after its name, and
            its redirect targets.
        kinds (Sequence[str | PathSpec]): the same words classified, a
            path as a PathSpec.
        cwd (str): the cwd the pass last knew.
        lost (bool): whether a ``cd`` the walk could not follow ran
            before the command.
    """
    unread = {cwd} if lost else set()
    read: set[str] = set()
    for w, kind in zip(words, kinds, strict=True):
        if w.text is None or (lost and not w.value.startswith("/")):
            unread.add(resolve_path(w.value, cwd))
        elif isinstance(kind, PathSpec):
            read.add(kind.virtual)
    return frozenset(unread - read)


def _line_decision(
    name: str,
    args: list[str],
    words: Sequence[Word],
    operands: Sequence[str | PathSpec],
    redirects: Sequence[PathSpec],
    inners: Sequence[InnerLine],
    rules: AdmissionRules | None,
    coded: bool,
    open_: bool,
    lost: bool,
    cwd: str,
) -> str | None:
    """Why a runtime that takes the line whole may not run a command the
    chain did not refuse, None when it may.

    Such a runtime expands, walks, globs and changes directory on its
    own (a remote sandbox's own disk, a host process), where no entry
    gate follows an I/O below the judged words, so a command a rule
    reads must not reach it with any of them in hand. A command a path
    or mount rule reads is refused when it walks (``find``,
    ``grep -r``, ``tar -c``) or names a glob; one a rule reads the
    arguments of when a word only the runtime can expand (a parameter,
    a substitution, an unquoted glob) stands among them, when the
    runtime appends operands (``xargs``, ``find -exec``) or when it runs
    after a ``cd`` the walk could not follow; and any command, under any
    rule, that runs lines the gate cannot read (a sourced file, a
    script, ``eval "$p"``). A user policy answering ``pre_command`` (in
    code, or a profile's program) is shown every command's expanded
    words off such a runtime, so here it refuses as a rule that reads
    every command's arguments does; it is never shown a walk's files,
    so a walk stays. With neither in force nothing is refused on this
    account.

    Args:
        name (str): the command name.
        args (list[str]): the words after it.
        words (Sequence[Word]): the command's words, name first, and
            the statement's redirect targets, as the gate read them.
        operands (Sequence[str | PathSpec]): the words after the name,
            classified.
        redirects (Sequence[PathSpec]): the redirect targets' paths.
        inners (Sequence[InnerLine]): the lines the command runs.
        rules (AdmissionRules | None): the session's admission rules.
        coded (bool): whether a policy other than Mirage's own answers
            ``pre_command`` for the session.
        open_ (bool): whether the runtime appends operands the gate
            cannot read.
        lost (bool): whether a ``cd`` the walk could not follow ran
            before the command.
        cwd (str): the working directory the line runs in.
    """
    if scopes_paths(rules, name):
        if line_facts(name, [name, *args], cwd).reads_subtree:
            return "walks a tree the gate cannot follow"
        if any(
            is_glob(p.raw_path or p.virtual)
            for p in (*operands, *redirects)
            if isinstance(p, PathSpec)
        ):
            return "expands a pattern only the runtime can read"
    if coded or reads_args(rules, name):
        unread = next((w.raw for w in words if w.text is None or w.glob), None)
        if unread is not None:
            return unreadable(unread)
        if open_:
            return "runs on operands the gate cannot read"
        if lost:
            return "runs after a cd the gate cannot follow"
    if (coded or has_rules(rules)) and any(
        not inner.readable for inner in inners
    ):
        return UNREADABLE_LINES
    return None


async def _judge_words(
    item: "Walked",
    registry: MountRegistry,
    namespace: Namespace | None,
    mode: JudgmentMode,
) -> AsyncIterator[Judged]:
    """Judge one command and whatever lines it runs in turn, each with
    its occurrence, one at a time, so a reader that stops at a refusal
    never asks the chain about what comes after it.

    The redirect targets are read as words of the command: the shell
    opens them on its own fds, outside the window the command's own gate
    covers, so a rule about ``/protected`` sees ``echo x > /protected``
    only if they are passed here. A line the command runs (``eval``,
    ``sh -c``) is parsed on its own and read under the command's
    occurrence, exactly as the nested evaluation will stand when it
    runs; words a command runs (``command``, ``env``, ``timeout``,
    ``xargs``) are read as the one line the builtin hands the evaluator,
    spelled as it spells it. For a runtime that takes the line whole
    this is the gate itself (:func:`admit_line`), so what ``explain``
    says about such a line is what its admission does: a deny first,
    then what the runtime would do past the gate (:func:`_line_decision`),
    then an ask.

    Args:
        item (Walked): the read command and its place in the shell.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        mode (JudgmentMode): how this judgment reads the command and policies.
    """
    whole_line = takes_whole_line(mode)
    words = item.words
    redirect_words = item.redirects
    if whole_line:
        words = [_machine_word(w) for w in words]
        redirect_words = tuple(_machine_word(w) for w in redirect_words)
    occurrence = item.occurrence
    session = item.session
    intrinsic = item.intrinsic
    lost = item.lost
    open_ = item.open_
    head = words[0]
    rules = session.commands
    if whole_line and await registry.policies.wants_for(
        "post_command", session.session_id
    ):
        # The runtime runs the commands itself: no command's result
        # comes back for a post_command policy to judge.
        yield Judged(
            _denied(
                head.raw,
                "a post_command policy cannot judge a line a runtime "
                "runs whole",
            ),
            occurrence,
            False,
        )
        return
    if head.text is None and not whole_line:
        return
    if whole_line and (head.text is None or head.glob) and has_rules(rules):
        yield Judged(
            _denied(head.raw, unreadable(head.raw)), occurrence, False
        )
        return
    stated = item.stated and all(
        w.text is not None for w in [*words, *redirect_words]
    )
    name = head.value
    args = [w.value for w in words[1:]]
    classified = await classified_words(name, args, session, registry)
    read_words = [*words[1:], *redirect_words]
    kinds = [
        *classified[1:],
        *(
            classify_bare_path(w.value, registry, session.cwd)
            for w in redirect_words
        ),
    ]
    unread = _unread_paths(
        read_words, kinds, session.cwd, lost and not whole_line
    )
    redirects = redirect_paths(redirect_words, registry, session.cwd)
    ctx, asked, answers = await gate(
        name,
        args,
        classified[1:],
        session,
        registry,
        namespace,
        stdin=item.stdin,
        redirects=redirects,
        intrinsic=intrinsic,
        unread=unread,
        every=mode in (JudgmentMode.EXPLAIN, JudgmentMode.EXPLAIN_WHOLE_LINE),
        rules_only=mode is JudgmentMode.PREPASS,
        line=occurrence.source,
    )
    # After a lost cd, a relative path names no file the pass can place.
    inners = (
        []
        if runs_function(name, session, registry)
        else inner_lines(name, words[1:])
        if lost and not name.startswith("/")
        else program_lines(
            words,
            session,
            registry,
            None if namespace is None else namespace.session_links(session),
            open_,
        )
    )
    if name == "trap" and not whole_line:
        # Mirage's shell judges a trap's action when it fires.
        inners = []
    coded = whole_line and await registry.policies.wants_for(
        "pre_command", session.session_id, coded_only=True
    )
    refused = (
        _line_decision(
            name,
            args,
            [head, *read_words],
            classified[1:],
            redirects,
            inners,
            rules,
            coded,
            open_,
            lost,
            session.cwd,
        )
        if whole_line and not isinstance(asked, Deny)
        else None
    )
    if refused is not None:
        yield Judged(
            dataclasses.replace(_denied(name, refused), words=ctx.words),
            occurrence,
            stated,
            intrinsic,
            unread,
        )
        return
    yield Judged(
        dataclasses.replace(
            await _explained(ctx, registry, asked, answers),
            words=ctx.words,
        ),
        occurrence,
        stated,
        intrinsic,
        unread,
        ctx,
        session,
    )
    # env's command runs in the environment env builds for it, and a
    # nested shell's line in a new shell started from this one.
    child = env_child(args, session) if name == "env" and inners else None
    inner_session = session
    if child is not None and not isinstance(child, str):
        inner_session = session.fork()
        inner_session.vars = ShellVars.of(
            env_vars(session, child[1]), session.ids.random_u32
        )
    elif name in ("sh", "bash") and inners:
        inner_session = session.new_shell()
    elif (name == "command" or "/" in name) and inners and inners[0].argv:
        inner_session = session.fork()
        inner_session.functions.pop(inners[0].argv[0].value, None)
        inner_session.aliases.pop(inners[0].argv[0].value, None)
    pipeline: _PipelineWalk | None
    if name in ("sh", "bash"):
        pipeline = _PipelineWalk(guest=whole_line)
    else:
        pipeline = (
            None
            if item.pipeline is None
            else dataclasses.replace(item.pipeline)
        )
    for inner in inners:
        if not inner.readable:
            continue
        if inner.line is not None:
            async for one in _judge_line(
                parse(inner.line, expanding_aliases(inner_session)),
                inner_session,
                registry,
                namespace,
                line_frame(inner.line, occurrence),
                mode,
                stated=stated and not inner.open,
                lost=lost,
                open_=inner.open,
                pipeline=pipeline,
            ):
                yield one
        else:
            argv = list(inner.argv)
            within = whole_occurrence(
                argv_frame([w.value for w in argv], occurrence)
            )
            place, moved = inner_session, lost
            if inner.chdir is not None:
                # `env -C` runs its command where `cd` would have gone.
                place, moved, _ = _after_cd(
                    [Word("cd", "cd"), inner.chdir], inner_session, lost, ()
                )
            async for one in _judge_words(
                Walked(
                    argv,
                    (),
                    place,
                    within,
                    stated=stated and not inner.open,
                    lost=moved,
                    open_=inner.open,
                    pipeline=pipeline,
                ),
                registry,
                namespace,
                mode,
            ):
                yield one


def _is_verdict(expl: Judgment) -> bool:
    """Whether an explanation refuses the line's intent, rather than
    just failing one command.

    A deny a tree states for a command it names, and whole-command
    policy refusals, hold the line. Filesystem refusals, about a path or
    carrying an error, wait for the per-command gate, where earlier
    commands have established the live cwd and namespace.
    Rule-less DENY results also wait, and so does a top-level tree
    root's own decision (``_by_default``): an unavailable head word, a
    command no tree names (a function the line defines first, say), or
    words only the runtime can expand fail where they occur rather than
    against the whole line. A mount entry's root speaks about its
    folder, so it holds the line (``_in_folder``).

    Args:
        expl (Judgment): one command's explanation.
    """
    if expl.exit_code == 0 or (_by_default(expl) and not _in_folder(expl)):
        return False
    if expl.rule is not None and expl.outcome is Outcome.DENY:
        return True
    # Filesystem refusals use the live cwd and fail only their command.
    denied = next((a for a in expl.answers if isinstance(a, Deny)), None)
    if denied is not None and (
        denied.path is not None or denied.error is not None
    ):
        return False
    return expl.rule is not None or expl.outcome is Outcome.ALLOW


def _by_default(expl: Judgment) -> bool:
    """Whether a tree's root decided the command by its own decision,
    which speaks for every command the tree names nothing for.

    Args:
        expl (Judgment): one command's explanation.
    """
    rule = expl.rule
    return rule is not None and rule.at.split("/")[1:2] == ["*"]


def _in_folder(expl: Judgment) -> bool:
    """Whether the leaf that decided the command belongs to a mount
    entry's tree, which judges only lines working inside its folder.

    Args:
        expl (Judgment): one command's explanation.
    """
    return expl.rule is not None and bool(expl.rule.mount)


def _uncovered(expl: Judgment) -> bool:
    """Whether the profile refuses a command no tree names (by a root's
    own decision, or a CLI that reaches a service, ``unlisted_service``),
    on its own words, which nothing that runs before it on the line can
    change.

    Args:
        expl (Judgment): one command's explanation.
    """
    return (
        expl.outcome is Outcome.DENY
        and (expl.source == "commands" or _by_default(expl))
        and _refuses(expl)
    )


def _refuses(expl: Judgment) -> bool:
    """Whether an explanation refuses the command outright, rather than
    reporting a line that would run or a question the host has not
    answered.

    Args:
        expl (Judgment): one command's explanation.
    """
    return expl.exit_code != 0 and not is_pending(expl.decision)


def _asks_for(one: Judged) -> bool:
    """Whether the pass may answer a command's question on the gate's
    behalf: it may when the gate will read the words the pass read, and
    a deny is always the pass's to enforce, since it speaks on the name
    alone. What is left is a question about a spelling the runtime
    completes, which is the gate's: asked here, it would be answered
    for words that never run.

    Args:
        one (Judged): the command's explanation and its place.
    """
    return one.stated or _refuses(one.judgment)


def _is_judged(expl: Judgment) -> bool:
    """Whether the compound-line pass puts a command through the gate.

    A verdict is, so the line is refused whole. So is a command that
    would run, because "would run" may mean a standing grant answers
    its ask, and only the gate can claim that grant for this line: read
    but not claimed, one nod answered every spelling of the command on
    the line, and a grant given to a line that was then refused stood
    for the next one. What stays out is the rule-less DENY, which
    :func:`_is_verdict` explains is answered where it happens.

    Args:
        expl (Judgment): one command's explanation.
    """
    return expl.exit_code == 0 or _is_verdict(expl)


@dataclass(slots=True)
class _PipelineWalk:
    """Options may change before the static walk reaches a pipeline."""

    background: bool = False
    options_may_change: bool = False
    guest: bool = False
    functions: frozenset[str] = frozenset()


def _pipeline_walk() -> _PipelineWalk:
    owner = current_caller().process
    return _PipelineWalk(background=owner is not None and owner.pipeline)


def _stage_forks(
    last: bool,
    session: SessionState,
    pipeline: _PipelineWalk,
    *,
    possible: bool = False,
) -> bool:
    return pipeline_stage_forks(
        last,
        PipelineScope(
            lastpipe=(
                possible
                if pipeline.guest or pipeline.options_may_change
                else session.shopts.get("lastpipe", False)
            ),
            monitor=(
                not possible
                if pipeline.guest or pipeline.options_may_change
                else session.shell_options.get("monitor", False)
            ),
            background_pipeline=pipeline.background,
        ),
    )


def _changes_pipeline_options(
    words: Sequence[Word], session: SessionState, pipeline: _PipelineWalk
) -> bool:
    """Whether a command may toggle lastpipe or job control.

    A literal setter may still be skipped, shadowed or denied. The static
    walk keeps both possibilities until the live executor reads the options.
    """
    if not words:
        return False
    head = words[0].text
    if (
        head is None
        or words[0].glob
        or head in session.functions
        or head in pipeline.functions
    ):
        return True
    index = 0
    while index < len(words) and words[index].text in ("command", "builtin"):
        index += 1
        if index < len(words) and words[index].text == "--":
            index += 1
    if index == len(words):
        return False
    if words[index].text is None or words[index].glob:
        return True
    if words[index].text not in ("shopt", "set"):
        return False
    operands = words[index + 1 :]
    if any(word.text is None or word.glob for word in operands):
        return True
    args = [word.value for word in operands]
    if words[index].text == "shopt":
        scan = scan_options(args, "pqosu")
        option = "monitor" if "o" in scan.letters else "lastpipe"
        return (
            scan.bad is None
            and ("s" in scan.letters) != ("u" in scan.letters)
            and option in scan.operands
        )
    index = 0
    while index < len(args):
        word = parse_option_word(
            args[index], args[index + 1] if index + 1 < len(args) else None
        )
        if word is None:
            break
        if any(option == "monitor" for option, _ in word.settings):
            return True
        index += word.consumed
    return False


@dataclass(frozen=True, slots=True)
class Walked:
    """One command of a walked line, as both readers of the line see
    it: its words, the redirect targets of its statement, the session
    it is judged in, and where it stands.

    Args:
        intrinsic (bool): the shell implements the operation directly.
        words (list[Word]): the command's words, name first.
        redirects (tuple[Word, ...]): the statement's redirect targets.
        stdin (bytes | None): empty when the statement redirects input.
        session (SessionState): the session the command is judged in.
        occurrence (Occurrence): the command's place on the line.
        lost (bool): a ``cd`` the walk could not follow ran before the
            command, so the session's cwd is not where it stands.
        stated (bool): whether the gate admits the command on these
            words once each is literal (``TestRead.stated``).
        elsewhere (tuple[SessionState, ...]): the other places the
            command may stand, where a ``cd`` before it was skipped or
            failed.
        open_ (bool): the runtime appends operands the gate cannot read
            (``xargs``, ``find -exec``, ``mapfile -C``).
    """

    words: list[Word]
    redirects: tuple[Word, ...]
    session: SessionState
    occurrence: Occurrence
    intrinsic: bool = False
    lost: bool = False
    stdin: bytes | None = None
    stated: bool = True
    elsewhere: tuple[SessionState, ...] = ()
    open_: bool = False
    pipeline: _PipelineWalk | None = None


# Where a scope leaves the shell: the session, whether a `cd` the walk
# could not follow lost the cwd, and the other places a `cd` that may have
# been skipped or failed leaves it.
Stand = tuple[SessionState, bool, tuple[SessionState, ...]]

# A walk yields each command and returns where its scope ends. That is
# how a `cd` reaches the commands after it without escaping the child
# shell it ran in.
Walk = Generator[Walked, None, Stand]


def _words_of(node: Any, homes: Mapping[str, str] | None) -> list[Word]:
    """One command node's words, name first, the env prefix dropped.

    Args:
        node (Any): the command's parsed node.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
    """
    _, parts = split_env_prefix(get_parts(node))
    return [read_word(part, homes) for part in parts]


def _seeded(
    node: Any, session: SessionState, homes: Mapping[str, str] | None
) -> SessionState:
    """The session a command runs in: ``session`` with the command's own
    ``NAME=value`` prefix exported, as the executor seeds it before the
    command's gate, so ``pre_execute`` reads the environment
    ``pre_command`` will. A value only the run expands is read as typed,
    as the command's words are, and a readonly name is left as it is.

    Args:
        node (Any): the command's tree-sitter node.
        session (SessionState): the session the command stands in.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
    """
    assigned, _ = split_env_prefix(get_parts(node))
    if not assigned:
        return session
    seeded = session.fork()
    for part in assigned:
        key, eq, raw = get_text(part).partition("=")
        if not eq or env_is_readonly(seeded, key, False):
            continue
        values = [
            c for c in part.named_children if c.type != NodeType.VARIABLE_NAME
        ]
        seed_var(
            seeded, key, read_word(values[0], homes).value if values else raw
        )
        set_attr(seeded, key, VarAttr.EXPORT)
    return seeded


def _walk_substitution(
    tree: Any,
    session: SessionState,
    homes: Mapping[str, str] | None,
    frame: Frame,
    pipeline: _PipelineWalk,
    lost: bool,
    elsewhere: tuple[SessionState, ...],
) -> Walk:
    """Walk a substitution as the evaluator parses and admits it.

    Args:
        tree (Any): the freshly parsed substitution body.
        session (SessionState): the shell whose paths are read.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
        pipeline (_PipelineWalk): the shell's pipeline options and owner.
        frame (Frame): the body's occurrence frame.
        lost (bool): whether the shell's cwd is lost, as ``Walked``
            carries it.
        elsewhere (tuple[SessionState, ...]): the other places the shell
            may stand, as ``Walked`` carries them.
    """
    redirect = input_substitution_redirect(tree)
    if redirect is None:
        return (
            yield from _walk_node(
                tree, session, homes, frame, pipeline, lost, elsewhere
            )
        )
    target = redirect.target_node
    assert target is not None
    yield Walked(
        [Word("cat", "cat")],
        (Word(get_text(target), literal_word(target, homes)),),
        session,
        occurrence_in(tree, frame),
        True,
        lost,
        elsewhere=elsewhere,
    )
    yield from _walk_node(
        target, session, homes, frame, pipeline, lost, elsewhere
    )
    return session, lost, elsewhere


def _walk_node(
    node: Any,
    session: SessionState,
    homes: Mapping[str, str] | None,
    frame: Frame,
    pipeline: _PipelineWalk,
    lost: bool = False,
    elsewhere: tuple[SessionState, ...] = (),
) -> Walk:
    """Every command under one node, in source order, each with the
    session it is judged in; returns where the node leaves the shell.

    A ``cd`` reaches the commands after it, and how far is the whole
    question. Pinned against bash: ``( )``, ``$( )`` and ``<( )`` run
    their contents in a child shell, so a ``cd`` inside one applies to
    the rest of that child and is gone when it exits; a pipeline forks
    once per segment unless its last stage runs in this shell, so a
    ``cd`` in one segment never reaches another stage. ``&`` backgrounds
    into a fork. A brace group or an ``if`` body stays in this shell, so its ``cd``
    does escape. Reading a subshell as "no ``cd`` applies" rather than
    "no ``cd`` escapes" judged ``(cd d && tar -c ..)`` at the wrong
    directory, which made ``..`` read as a mount root. A loop or a
    function body runs again from where it ended, so one that moves the
    cwd is walked with it lost.

    The session is returned rather than carried down because that is
    what "escapes" means, and because ``&`` is not a wrapper node: it is
    a token following its command, visible only to whoever holds the
    sibling list.

    A substitution's body is walked in a frame of its own
    (``body_frame``): the nested line that evaluates it parses the body
    alone, under the substitution's node, and the commands in it have
    to be placed here exactly where that line will place them. A
    backtick region is walked as the lines it runs (``segment_frames``),
    each parsed here as the evaluator parses it.

    Args:
        node (Any): the parsed node to walk.
        session (SessionState): the session this node begins in.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
        pipeline (_PipelineWalk): the shell's pipeline options and owner.
        frame (Frame): the scope the node is read in.
        lost (bool): whether the node begins with its cwd lost, as
            ``Walked`` carries it.
        elsewhere (tuple[SessionState, ...]): the other places the node
            may begin in, as ``Walked`` carries them.
    """
    scope = scope_kind(node)
    if scope == ScopeKind.DEFERRED:
        frame = definition_frame(node, frame)
        pipeline.functions |= {get_function_name(node)}
        pipeline = dataclasses.replace(pipeline)
    opened = (
        opened_by(node, homes)
        if node.type in OPENERS
        or (
            node.type == NodeType.COMMAND and get_text(node).startswith("exec")
        )
        else ()
    )
    if opened:
        # The files the shell opens for no command as it reaches the
        # node, where it stands: no command's words, so only a walk
        # that asks for them sees them (``_walked_line``).
        yield Walked(
            [],
            opened,
            session,
            occurrence_in(node, frame),
            lost=lost,
            elsewhere=elsewhere,
            pipeline=pipeline,
        )
    if node.type == NodeType.TEST_COMMAND:
        # The shell's own test, judged as a command of its own name, a
        # test at a time as the gate admits it.
        for test in reads_of_test(node, homes):
            yield Walked(
                test.words,
                statement_redirects(node, homes),
                session,
                occurrence_in(node, frame),
                True,
                lost,
                stdin=statement_stdin(node),
                stated=test.stated,
                elsewhere=elsewhere,
                pipeline=pipeline,
            )
        for child in node.children:
            yield from _walk_node(
                child, session, homes, frame, pipeline, lost, elsewhere
            )
        return session, lost, elsewhere
    if node.type == NodeType.COMMAND:
        walked: Stand = session, lost, elsewhere
        words = _words_of(node, homes)
        if words:
            yield Walked(
                words,
                statement_redirects(node, homes),
                _seeded(node, session, homes),
                occurrence_in(node, frame),
                lost=lost,
                stdin=statement_stdin(node),
                elsewhere=tuple(_seeded(node, e, homes) for e in elsewhere),
                pipeline=pipeline,
            )
            walked = _after_cd(words, session, lost, elsewhere)
        for child in node.children:
            # A substitution among the words runs in its own shell.
            yield from _walk_node(
                child, session, homes, frame, pipeline, lost, elsewhere
            )
        if not pipeline.options_may_change:
            pipeline.options_may_change = _changes_pipeline_options(
                words, session, pipeline
            )
        return walked
    if scope in (ScopeKind.FORK, ScopeKind.SUBSTITUTION):
        child_pipeline = dataclasses.replace(pipeline, background=False)
        segments = segment_frames(node, frame)
        if segments:
            # A backtick region is read as the evaluator runs it: its
            # body parsed again once its backslashes are gone, because
            # the node's subtree is not what runs.
            for segment in segments:
                yield from _walk_substitution(
                    parse(segment.text, expanding_aliases(session)),
                    session,
                    homes,
                    segment,
                    child_pipeline,
                    lost,
                    elsewhere,
                )
            return session, lost, elsewhere
        inner = body_frame(node, frame)
        if node.type == NodeType.COMMAND_SUBSTITUTION and inner is not None:
            yield from _walk_substitution(
                parse(inner.text, expanding_aliases(session)),
                session,
                homes,
                Frame(inner.text, 0, inner.parent),
                child_pipeline,
                lost,
                elsewhere,
            )
            return session, lost, elsewhere
        yield from _walk_children(
            node,
            session,
            homes,
            frame if inner is None else inner,
            child_pipeline,
            lost,
            elsewhere,
        )
        return session, lost, elsewhere
    if scope == ScopeKind.PIPELINE:
        stages = node.named_children
        ended = session, lost, elsewhere
        for index, stage in enumerate(stages):
            last = index == len(stages) - 1
            forked = _stage_forks(last, session, pipeline)
            child_pipeline = (
                dataclasses.replace(pipeline, background=False)
                if forked
                else pipeline
            )
            after = yield from _walk_node(
                stage, session, homes, frame, child_pipeline, lost, elsewhere
            )
            if not forked:
                ended = after
            elif not _stage_forks(last, session, pipeline, possible=True) and (
                pipeline.guest or after[0] is not session or after[1] != lost
            ):
                if pipeline.guest:
                    # The guest may keep its cwd or the last stage's. The
                    # whole-line gate must judge both before handing it off.
                    places = {
                        place.cwd: place
                        for place in (*elsewhere, after[0], *after[2])
                        if place.cwd != session.cwd
                    }
                    ended = (
                        session,
                        after[1] or len(places) > PLACES_LIMIT,
                        tuple(places.values())
                        if len(places) <= PLACES_LIMIT
                        else elsewhere,
                    )
                else:
                    # The live command gate can judge the real path.
                    ended = session, True, elsewhere
        return ended
    if scope in (ScopeKind.REPEATED, ScopeKind.DEFERRED) and _moves(
        node, session, homes, pipeline
    ):
        lost = True
    return (
        yield from _walk_children(
            node, session, homes, frame, pipeline, lost, elsewhere
        )
    )


def _moves(
    node: Any,
    session: SessionState,
    homes: Mapping[str, str] | None,
    pipeline: _PipelineWalk,
) -> bool:
    """Whether a scope may change cwd across invocations or iterations."""
    stack = [(node, False)]
    moved_in_last_stage = False
    changes_options = False
    while stack:
        current, needs_lastpipe = stack.pop()
        scope = scope_kind(current)
        if scope in (ScopeKind.FORK, ScopeKind.SUBSTITUTION):
            continue
        if scope == ScopeKind.PIPELINE:
            stages = current.named_children
            if stages and not pipeline.background:
                stack.append(
                    (
                        stages[-1],
                        needs_lastpipe
                        or _stage_forks(
                            True, session, pipeline, possible=True
                        ),
                    )
                )
            continue
        if current.type == NodeType.COMMAND:
            words = _words_of(current, homes)
            if words:
                if not needs_lastpipe:
                    changes_options |= _changes_pipeline_options(
                        words, session, pipeline
                    )
                after, lost, _ = _after_cd(words, session, False, ())
                if lost or after is not session:
                    if not needs_lastpipe:
                        return True
                    moved_in_last_stage = True
        stack.extend(
            (child, needs_lastpipe)
            for child in current.children
            if not is_backgrounded(child)
        )
    return moved_in_last_stage and changes_options


def _walk_children(
    node: Any,
    session: SessionState,
    homes: Mapping[str, str] | None,
    frame: Frame,
    pipeline: _PipelineWalk,
    lost: bool,
    elsewhere: tuple[SessionState, ...],
) -> Walk:
    """One scope's children in order, threading the cwd between them;
    returns where the scope ends.

    Args:
        node (Any): the parsed node whose children form the scope.
        session (SessionState): the session the scope begins in.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
        pipeline (_PipelineWalk): the shell's pipeline options and owner.
        frame (Frame): the scope the children are read in.
        lost (bool): whether the scope begins with its cwd lost.
        elsewhere (tuple[SessionState, ...]): the other places the
            scope may begin in.
    """
    for child in node.children:
        background = is_backgrounded(child)
        child_pipeline = (
            dataclasses.replace(
                pipeline, background=background_pipeline(child)
            )
            if background
            else pipeline
        )
        ended = yield from _walk_node(
            child, session, homes, frame, child_pipeline, lost, elsewhere
        )
        if not background:
            session, lost, elsewhere = ended
    return session, lost, elsewhere


def _after_cd(
    words: list[Word],
    session: SessionState,
    lost: bool,
    elsewhere: tuple[SessionState, ...],
) -> Stand:
    """Where the next command of a line stands, which differs from this
    one only when this command moved the shell.

    ``cd /repo && git commit`` is judged before the line runs, so
    without this the rule about ``/repo`` reads the cwd the session
    happened to be in and answers about the wrong directory. A ``cd``
    may also be skipped (``false && cd d``) or fail, so the shell may
    still stand anywhere it stood before: those places ride along, and a
    runtime that takes the line whole admits a command only where every
    one of them does. A ``cd`` the walk cannot follow (``cd "$d"``,
    ``cd -``, any once the cwd is lost, since it too may fail), a line
    run in this shell (``eval``, ``source``) or the directory stack loses
    the cwd, and what the commands after it name relative to it is the
    per-command gate's to judge, in the real one: judged in the cwd the
    walk last knew, ``cd "$d" && rm x`` refused a line that removes an
    allowed file.

    Args:
        words (list[Word]): the command's words, name first.
        session (SessionState): the session the command was judged in.
        lost (bool): whether the command's cwd was already lost.
        elsewhere (tuple[SessionState, ...]): the other places the
            command may stand.
    """
    name = words[0].value
    if name in ("command", "builtin") and len(words) > 1:
        return _after_cd(words[1:], session, lost, elsewhere)
    if name in CWD_MOVERS:
        return session, True, elsewhere
    if name != "cd":
        return session, lost, elsewhere
    target = words[1].text if len(words) == 2 else None
    if lost or target is None or target.startswith("-"):
        return session, True, elsewhere
    predicted = session.fork(cwd=resolve_path(target, session.cwd))
    places: dict[str, SessionState] = {}
    for place in (
        session,
        *elsewhere,
        *(e.fork(cwd=resolve_path(target, e.cwd)) for e in elsewhere),
    ):
        if place.cwd != predicted.cwd:
            places.setdefault(place.cwd, place)
    if len(places) > PLACES_LIMIT:
        return session, True, elsewhere
    return predicted, False, tuple(places.values())


def _walked_line(
    ast: Any,
    session: SessionState,
    frame: Frame | None = None,
    lost: bool = False,
    opens: bool = False,
    pipeline: _PipelineWalk | None = None,
    homes: Mapping[str, str] | None = None,
) -> Iterator[Walked]:
    """Every command of a line with its redirect targets, the session
    it is judged in and its place on the line.

    The cwd is the one fact that moves as a line runs, and both readers
    of a line need the same answer about it: a host asking what a line
    would do and the pass deciding whether to let it run cannot differ,
    or ``explain`` would report an allow the run then refuses. The
    redirects ride along for the same reason: they are read here so both
    readers judge the file the shell opens, not just the operands.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        frame (Frame | None): the scope the line is read in; None
            reads ``ast`` as a line of its own.
        lost (bool): whether the line begins with its cwd lost, as a
            line a command runs after such a ``cd`` does.
        opens (bool): also yield each statement's redirects no command
            owns, as an item with no words, where the statement stands
            (``explain_redirects``).
        homes (Mapping[str, str] | None): the homes each ``~name`` names;
            None for the session's own.
    """
    if frame is None:
        frame = root_frame(ast, None)
    if pipeline is None:
        pipeline = _pipeline_walk()
    if homes is None:
        homes = tilde_homes(session)
    for item in _walk_node(ast, session, homes, frame, pipeline, lost):
        if item.words or opens:
            yield item


def may_prejudge(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
) -> bool:
    """Whether :func:`line_judgments` may judge two commands of ``ast``,
    the least :func:`prejudge_line` refuses a line on.

    It walks the line as that pass does and stops at the second command;
    for a line with one, that command is judged once more only for the
    lines it runs (``eval``, ``sh -c``, ``env``, ``xargs``, ``find
    -exec``), read as the pass reads them. False means the pass would
    judge fewer than two commands, so a one-command line skips it and
    its command is judged once, by the per-command gate. True only
    sends the line through the pass, which counts again.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the CLI installs and
            mount lookups.
        namespace (Namespace | None): the link table.
        handed (HandOff): the line's hand-off, whose origin places each
            command on the line.
    """
    frame = root_frame(ast, handed.origin)
    only: Walked | None = None
    for item in _walked_line(ast, session, frame):
        if item.words[0].text is None:
            continue
        if only is not None:
            return True
        only = item
    if only is None:
        return False
    name = only.words[0].value
    if runs_function(name, only.session, registry):
        return False
    inners = (
        inner_lines(name, only.words[1:])
        if only.lost and not name.startswith("/")
        else program_lines(
            only.words,
            only.session,
            registry,
            None
            if namespace is None
            else namespace.session_links(only.session),
            only.open_,
        )
    )
    return any(inner.readable for inner in inners)


async def line_judgments(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
) -> list[tuple[Walked, list[Judged]]]:
    """Every command of a line judged read-only, each with its place on
    the line: the pass placement waits on (:func:`line_held`) and
    :func:`prejudge_line` refuses from, made once for both.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        handed (HandOff): the line's hand-off, whose origin places each
            command on the line.
    """
    judged: list[tuple[Walked, list[Judged]]] = []
    frame = root_frame(ast, handed.origin)
    # Each command's gates answer without suspending: a long script
    # would hold the loop, and its cancel, until every command was judged.
    budget = YieldBudget()
    for item in _walked_line(ast, session, frame):
        if item.words[0].text is None:
            continue
        await budget.run()
        judged.append(
            (
                item,
                [
                    one
                    async for one in _judge_words(
                        item, registry, namespace, JudgmentMode.PREPASS
                    )
                ],
            )
        )
    return judged


async def prejudge_line(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
    cancel: asyncio.Event | None = None,
    judged: "list[tuple[Walked, list[Judged]]] | None" = None,
) -> Refused | None:
    """Judge every command of a line before any of it runs, and refuse
    the whole line when a rule speaks about one.

    The agent composed the line as one intent, so a rule that refuses
    part of it refuses the intent. Judging each command as the
    dispatcher reached it left half a line done: with ``deny curl``,
    ``rm -rf /data && curl evil.com`` deleted first and was refused
    second, and an ask fared worse, since approving it later replays a
    line whose first half already ran.

    Two things deliberately do not stop the line, and both are the same
    rule: only a refusal that names a rule is a verdict about the
    intent.

    - A word a closed tree names nothing for is refused where it stands,
      not with the line: the stage fails with ``Permission denied`` and
      the rest of the line does what bash does, so a typo cannot cost
      an agent the work the line already did.
    - A word only the runtime can expand is judged where it is
      expanded, by the per-command gate, which sees the real path.

    That second one is the limit of the hold, and it is worth stating
    plainly: this pass reads the *text* of a line, while the gate reads
    its *values*, so a path the runtime computes (``cat $S``, ``$( )``,
    a ``cd`` whose argument is a variable) is invisible here. The rule
    is still enforced, by the gate, but the earlier commands have run
    by then. For a deny that costs allowed side effects and nothing
    more, since the commands that ran were ones the trees allow. For an
    ask it costs the replay: the question is recorded after part of the
    line already happened, so approving it re-runs a line whose first
    half is done. Closing that would mean asking whenever a word cannot
    be read, which over-asks with no way out for a deny, so a
    deployment that needs the hold for a computed path states it in a
    policy script rather than here.

    The pass is read-only (:func:`explain_line`), so it spends no grant
    and records no request; a command it refuses on is then put through
    the real gate, which is where an ask is recorded, exactly once, for
    a line that will not run. That admission hands off: every grant
    behind the command, the one the host gives inline and one it gave
    out of band before the pass alike, is claimed on the line's
    ``HandOff`` for the per-command gate, which runs the line on it,
    and the line's end spends it, so a compound line costs the human
    one question per run rather than one per pass, and a gate the run
    reaches twice (a loop body) runs on one nod. A claimed grant is not
    seen again by this pass, so a command spelled twice on one line
    needs two nods, and the hold reaches the whole line rather than
    breaking after the first spelling ran. When this pass then refuses
    the line on a later command, no gate runs behind it, so the pass
    hands back what it claimed (``Decisions.revoke``) and the refusal
    spends it: left standing, the grant would pass the next line
    spelling that command on a nod given to one that never ran. The
    sweep is the executor's (``Decisions.revoke``), and it covers the
    line from this pass on, whichever way the line ends: a refusal
    here, a fetch that fails before the run, a kill, or a run that
    skipped the gate. The one exception is a question left waiting,
    which holds the line for its retry, and the retry has to find the
    grants standing or the human is asked again for what they already
    allowed.

    A question is only asked here when the gate will ask the same one.
    The gate reads a word the runtime expands as its value and the
    words ``xargs`` or ``find -exec`` hand on with the operands the
    runtime appends, so a question about ``cat $F`` or a bare ``cat``
    would be answered for words that never run and the gate would ask
    again, after the earlier commands ran, about the words that do.
    Such a command (``Judged.stated`` False) is judged here for a deny,
    which speaks on the name alone and still holds the line, and its
    question is left to the gate; the hold does not reach it, which is
    the limit stated above in another form.

    Every command is judged whether or not the session carries a
    document, by the profile's rules alone: a policy registered in code
    or a profile's script answers ``pre_command`` once, at the gate that
    runs the command, and a line it should refuse whole is
    ``pre_execute``'s to refuse. Refusals about a path or carrying an
    error, MountRootPolicy's included, remain the per-command gate's
    responsibility.

    A line with one command to judge is left to the per-command gate,
    which is not an optimization but the more faithful answer: there is
    no earlier command whose side effects a hold could save, and the
    gate refuses from inside the shell, so the line's own redirections
    still apply. This pass answers above them, so refusing
    ``rm -rf /mnt 2>&1`` here wrote the refusal to stderr where bash
    puts it on stdout.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        handed (HandOff): the line's hand-off, on which every grant
            claimed here rides to the executor's sweep.
        cancel (asyncio.Event | None): the run's kill channel. This
            pass puts real questions to a host, so it carries it
            exactly as the per-command gate does; without it a compound
            line asked here waited on an answer its own timeout could
            no longer cut short.
        judged (list[tuple[Walked, list[Judged]]] | None): the line's
            read-only judgments (:func:`line_judgments`) when placement
            already made them, so the policies are asked once.

    Returns:
        The line's refusal, or None to run it.
    """
    if judged is None:
        if not may_prejudge(ast, session, registry, namespace, handed):
            return None
        judged = await line_judgments(
            ast, session, registry, namespace, handed
        )
    if sum(len(explained) for _, explained in judged) < 2:
        return None
    for _, explained in judged:
        for one in explained:
            if not _is_judged(one.judgment) or not _asks_for(one):
                continue
            # This pass judges on the gate's behalf and runs nothing
            # itself, so a grant the host gives here is claimed for the
            # per-command gate that runs the line, and spent when the
            # line ends: one question per run, not per pass.
            refused = await _admitted(one, registry, handed, cancel)
            if refused is not None:
                return refused
            # The host answered this one inline. The rest of the line
            # has not been judged yet, so the scan goes on: stopping
            # here let a later command's deny run behind an approval.
    return None


async def _admitted(
    one: Judged,
    registry: MountRegistry,
    handed: HandOff | None,
    cancel: asyncio.Event | None,
) -> Refused | None:
    """One judged command put through the ledger, as the gate puts it.

    A command refused before any policy was asked (``Judged.ctx`` None)
    stands as judged. Otherwise the chain's answer the judgment recorded
    is the gate's, and its Ask is answered from the session's grants or
    the host and claimed on the line's hand-off for this occurrence, so
    the policies are asked once per command, by the pass that judged it.

    Args:
        one (Judged): the command's judgment and its place on the line.
        registry (MountRegistry): registry holding the decision ledger.
        handed (HandOff | None): the line's hand-off, None outside a
            line.
        cancel (asyncio.Event | None): the run's kill channel.

    Returns:
        The command's refusal, or None to let it run.
    """
    judgment = one.judgment
    if one.ctx is None:
        return Refused(
            encode_text(judgment.stderr), judgment.exit_code, judgment.decision
        )
    action = await resolved(
        one.ctx,
        _refusal(judgment.answers),
        registry,
        cancel,
        Claimant(handed, one.occurrence) if handed is not None else None,
    )
    if action is None:
        return None
    err, code = await render_command_deny(judgment.command, action, one.ctx)
    return Refused(err, code, decision_of(action))


async def admit_line(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    cancel: asyncio.Event | None = None,
    handed: HandOff | None = None,
    off_line: Callable[[Judged], bool] | None = None,
) -> Refused | None:
    """Admit every command of a line a runtime takes whole.

    A whole line is a command like any other, but the runtime does the
    expanding, so the gate reads the line as typed, walked as
    ``explain`` walks it: each command is judged on its literal words
    (quotes removed, escapes resolved, a path-shaped word a path, an
    installed CLI's verb path walked) where it stands, a ``cd`` before
    it on the line included, and the first refusal is the line's. A
    statement's redirect targets are read as words of its command, so
    ``cat < /data/secret`` is judged on the file it opens, and a redirect
    no command owns (``{ cat; } < f``, ``> f``) is judged on its target
    as the shell would open it, where it stands (``admit_redirect``),
    so each open is a nod of its own; the lines a
    command runs (``eval``, ``sh -c``, ``xargs``, ``env`` ... see
    ``inner_lines``) are judged in turn; and what the runtime would do
    past the gate is refused under a rule, or a user ``pre_command``
    policy, that would have read it (:func:`_line_decision`). A command
    a ``pre_command`` route places off the runtime or machine the line
    runs whole on is refused too, since one run cannot put it elsewhere.

    No gate follows this pass: the runtime runs the line whole, so
    every grant it matches is claimed on the line's hand-off exactly as
    any reader on a line claims, and the executor's sweep spends them
    when the line ends. A line held on a question still waiting keeps
    its earlier answers standing for the retry, exactly as the
    compound-line pass does, where spending them here asked the human
    again for each on every retry.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        cancel (asyncio.Event | None): the run's kill channel.
        handed (HandOff | None): the line's hand-off, None outside a
            line (a bare admission with no run behind it).
        off_line (Callable[[Judged], bool] | None): whether a
            command's route places it off where the line runs whole
            (``Router.off_line``); None reads no command route.
    """
    async for one in _judge_line(
        ast,
        session,
        registry,
        namespace,
        root_frame(ast, handed.origin if handed is not None else None),
        JudgmentMode.WHOLE_LINE,
    ):
        refused = await _admitted(one, registry, handed, cancel)
        if refused is None and off_line is not None:
            refused = await off_line_refusal(one, off_line)
        if refused is not None:
            return refused
    for word, at in unowned_redirects(ast, tilde_homes(session)):
        refused = await admit_redirect(
            redirect_paths([word], registry, session.cwd),
            session,
            registry,
            namespace,
            at,
        )
        if refused is not None:
            return refused
    return None


async def off_line_refusal(
    one: Judged, off_line: Callable[[Judged], bool]
) -> Refused | None:
    """The refusal of a command a ``pre_command`` route places off the
    runtime or machine its line runs whole on, which that one run cannot
    honor; None for one that stays.

    Args:
        one (Judged): the command's judgment and its place on the line.
        off_line (Callable[[Judged], bool]): whether its route places it
            off the line (``Router.off_line``).
    """
    route = command_route(one.judgment.answers)
    if route is None or one.ctx is None or not off_line(one):
        return None
    command = one.judgment.command
    action = Deny(
        f"{route.policy} routes {command} elsewhere, and a line "
        "run whole runs in one place",
        policy=route.policy,
    )
    err, code = await render_command_deny(command, action, one.ctx)
    return Refused(err, code, decision_of(action))


def refused_where_it_stands(one: Judged, deny: Deny) -> Judged:
    """A command a ``Deny`` refuses at its own node, rendered as its run
    renders it, while the rest of its line still runs.

    Args:
        one (Judged): the command's judgment and its place on the line.
        deny (Deny): why its run refuses it.
    """
    err, code = render_deny(one.judgment.command, deny)
    return dataclasses.replace(
        one,
        judgment=dataclasses.replace(
            one.judgment,
            outcome=Outcome.DENY,
            reason=deny.reason,
            exit_code=code,
            stderr=decode_text(err),
            decision=decision_of(deny),
        ),
    )


async def _verdict_refuses(
    judged: Judged,
    registry: MountRegistry,
    handed: HandOff,
    cancel: asyncio.Event | None,
) -> bool:
    """Whether a verdict's answer refuses the command, putting an
    unanswered ask's question to the host.

    The rules' own answer the pass recorded is read, the first deny
    else the first ask, the way the gate picks it. A deny refuses
    outright. An ask's settled record is read without being spent
    (``Decisions.held``), so the gate that then runs the line consumes
    the same answer, in its own voice and behind the line's
    redirections; an unanswered rule is raised through the same ledger
    the gate reads, so the answer lands exactly once and the gate does
    not ask again.

    Args:
        judged (Judged): the verdict's explanation and its occurrence.
        registry (MountRegistry): registry holding the decision ledger.
        handed (HandOff): the line's hand-off, on which an answer given
            here is claimed for the gate.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    ctx = judged.ctx
    if ctx is None:
        return True
    asked = settled(judged.judgment.answers)
    if not isinstance(asked, Ask):
        return isinstance(asked, Deny)
    claimant = Claimant(handed, judged.occurrence)
    standing = registry.decisions.held(ctx, asked, claimant)
    if standing is None:
        return False
    if isinstance(standing, Deny):
        return True
    # hand_off: this pass exists to decide whether a secret is fetched, and
    # the gate behind it still has to admit the line. An answer given here is
    # claimed for that gate, which runs on it -- so the host is asked once.
    return await resolved(ctx, asked, registry, cancel, claimant) is not None


def _defines_function(node: Any) -> bool:
    """Whether the node defines a function anywhere in its tree.

    A definition's body is walked by ``_walked_line`` like any other
    scope, but it runs at invocation, not here, so a command inside one
    must not be read as the node's own: judging it would refuse a line
    that only stores text, and the read walks already charge nothing
    for it.

    Args:
        node (Any): the parsed node to scan.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == "function_definition":
            return True
        stack.extend(current.named_children)
    return False


def _sole_literal_command(
    node: Any, session: SessionState, frame: Frame
) -> Walked | None:
    """The node's one fully-literal command, when nothing else in the
    node can read a name.

    A walked node's reads can be discounted only when the whole node is
    one command, every word and redirect of it is literal, it defines
    nothing, and its tree reads no name any other way: such a node
    reads only what that one command's own grammar reads, so a refusal
    of the command is a refusal of every read the node contributes.
    Anything less provable -- a second command, a word only the runtime
    can expand, a ``$NAME`` anywhere -- returns None, and the caller
    keeps the node, because some part of it may still run and read.

    Args:
        node (Any): one walked node (the line's tree or a stored body).
        session (SessionState): the session the line runs in.
        frame (Frame): the scope the node is read in.
    """
    items = list(_walked_line(node, session, frame))
    if len(items) != 1:
        return None
    item = items[0]
    if any(word.text is None for word in (*item.words, *item.redirects)):
        return None
    if _defines_function(node):
        return None
    if referenced_names(node) or opaque_reads(node):
        return None
    return items[0]


async def _command_refused(
    item: Walked,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
    cancel: asyncio.Event | None,
    line: bool = False,
) -> bool:
    """Whether one walked command is refused on its text, resolving an
    unanswered ask through the ledger the gate reads.

    Args:
        item (Walked): the command's words, redirect targets, the
            session it is judged in and its place on the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        handed (HandOff): the line's hand-off.
        cancel (asyncio.Event | None): the run's kill channel.
        line (bool): whether the command is the whole line, which runs
            nothing at all once a tree's root refuses it.
    """
    explained = [
        one
        async for one in _judge_words(
            dataclasses.replace(item, intrinsic=False),
            registry,
            namespace,
            JudgmentMode.PREPASS,
        )
    ]
    # The profile refusing the line's one command on words no glob
    # can change means nothing runs. A line it hands on, or a line handed
    # on to it, is not enough: what runs it may not ask the gate.
    globbed = any(word.glob for word in (*item.words, *item.redirects))
    if (
        line
        and explained
        and not globbed
        and _uncovered(explained[0].judgment)
    ):
        return True
    for judged in explained:
        # A question about a spelling the runtime completes is the
        # gate's (``_asks_for``); the node is kept, and over-keeping
        # only ever over-fetches.
        if not _is_verdict(judged.judgment) or not _asks_for(judged):
            continue
        if await _verdict_refuses(judged, registry, handed, cancel):
            return True
    return False


async def unrefused_nodes(
    nodes: Sequence[Any],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
    cancel: asyncio.Event | None = None,
) -> list[Any]:
    """The walked nodes whose reads an env-plane fetch still serves.

    The fill derives its fetch set from this same list (``line_nodes``:
    the line's own tree first, then every stored body and alias
    expansion its words can invoke), and a fetch serves a command that
    is going to run, so refusals are judged over the same nodes reads
    are. One rule for every node: when it is one fully-literal command
    with no other read in it (``_sole_literal_command``), the gate is
    asked here on exactly the words it will read at run time, and a
    refusal discounts every read the node contributes. The line's own
    refusal drops the whole list, because nothing runs at all; a
    refused body or alias drops just itself, because the invocation
    still runs and is refused in place. A node this pass cannot prove
    silent is kept, and over-keeping only ever over-fetches.

    An ASK is resolved rather than skipped, because the fetch is itself
    an effect: contacting a secret store for a line the host then
    refuses would do a piece of exactly what was refused. A settled
    answer is read without being spent; an unanswered rule is put to
    the host now, through the same ledger the gate reads, so the answer
    lands exactly once -- an approval keeps the node and the gate
    consumes the grant, while a denial or a question left waiting drops
    it, and the line still runs into the gate, which refuses in place
    with its wording and its redirections.

    Args:
        nodes (Sequence[Any]): the line's walked set (``line_nodes``),
            the line's own tree first.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        handed (HandOff): the line's hand-off, on which an approval
            given here is claimed for the gate.
        cancel (asyncio.Event | None): the run's kill channel, carried
            because an unanswered ask is put to the host here.
    """
    out: list[Any] = []
    for position, node in enumerate(nodes):
        # Each node is read in the frame of its own tree: the line's,
        # or the one a stored body was parsed from, which is the frame
        # its gate will read it in. An alias expansion is parsed here
        # with a rest word no reader can spell (``line_nodes``), so it
        # is never one literal command and its frame goes unread; its
        # gate reads it under the word that invoked it.
        item = _sole_literal_command(
            node, session, gate_frame(node, nodes[0], session, handed)
        )
        if item is None:
            out.append(node)
            continue
        if await _command_refused(
            item, registry, namespace, handed, cancel, position == 0
        ):
            if position == 0:
                return []
            continue
        out.append(node)
    return out


async def _judge_line(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    frame: Frame,
    mode: JudgmentMode,
    *,
    stated: bool = True,
    lost: bool = False,
    open_: bool = False,
    pipeline: _PipelineWalk | None = None,
) -> AsyncIterator[Judged]:
    """Every command of a line judged, in the order the gate reads
    them, each with its place on the line, one at a time as
    ``_judge_words`` yields them.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        frame (Frame): the scope the line is read in.
        mode (JudgmentMode): how this judgment reads the commands and policies.
        stated (bool): whether the line's text reaches here as the gate
            will read it, as ``_judge_words`` takes it.
        lost (bool): whether the line begins with its cwd lost, as a
            line a command runs after such a ``cd`` does.
        open_ (bool): whether the runtime appends operands the gate
            cannot read to the line (``mapfile -C``'s callback, which
            runs with the index and the record after it), as
            ``_judge_words`` takes it for each of its commands.
    """

    def judged(item: Walked, place: SessionState) -> AsyncIterator[Judged]:
        return _judge_words(
            dataclasses.replace(
                item, session=place, stated=stated and item.stated, open_=open_
            ),
            registry,
            namespace,
            mode,
        )

    whole_line = takes_whole_line(mode)
    if pipeline is None and whole_line:
        # The runtime receives the line, cwd and environment. Its shell
        # options are independent of the workspace's.
        pipeline = _PipelineWalk(guest=True)
    # What the machine's shell runs on its own: a hook set on the line, or
    # one the session's environment hands it.
    hooked = _written(ast, HOOK_VARS) if whole_line else None
    carried = (
        next((n for n in env_snapshot(session) if is_hook(n)), None)
        if whole_line
        else None
    )
    if (hooked is not None or carried is not None) and (
        has_rules(session.commands)
        or await registry.policies.wants_for(
            "pre_command", session.session_id, coded_only=True
        )
    ):
        node, name = hooked if hooked is not None else (ast, str(carried))
        yield Judged(
            _denied(name, UNREADABLE_LINES), occurrence_in(node, frame), False
        )
        return
    homes = tilde_homes(session)
    if whole_line and (
        _written(ast, HOME_VAR) or _written(_typed_line(ast, frame), HOME_VAR)
    ):
        # The machine's shell expands a later `~` with the HOME it was set.
        homes = {name: home for name, home in homes.items() if name}
    for item in _walked_line(
        ast, session, frame, lost, pipeline=pipeline, homes=homes
    ):
        if not whole_line or not item.elsewhere:
            async for one in judged(item, item.session):
                yield one
            continue
        places = [
            [one async for one in judged(item, place)]
            for place in (item.session, *item.elsewhere)
        ]
        for one in _strictest(places):
            yield one


def _typed_line(ast: Any, frame: Frame) -> Any:
    """The parse of the line a frame's text was typed in: ``ast`` itself
    for a typed line, else the outermost line it was evaluated from.

    Args:
        ast (Any): the parsed root node of the frame's text.
        frame (Frame): the scope the line is read in.
    """
    at = frame.parent
    if at is None:
        return ast
    while at.parent is not None:
        at = at.parent
    return parse(at.source)


def _machine_word(word: Word) -> Word:
    """A word as a whole line's gate reads it: a leading ``~`` the gate
    left unexpanded (a user it does not know, ``~+``, or ``~`` once the
    line set HOME) names what only the machine's shell can say.

    Args:
        word (Word): the word as the walk read it.
    """
    if word.text is None:
        return word
    if word.raw[:1] == word.text[:1] == "~" or _ASSIGNED_TILDE.match(word.raw):
        return Word(word.raw, None, word.glob)
    return word


def _written(ast: Any, names: frozenset[str]) -> tuple[Any, str] | None:
    """The first node anywhere on a line (a function body or a
    substitution's included) that sets one of ``names``, with the name:
    an assignment, a loop variable, a ``declare -n`` aimed at one, or a
    builtin storing into one (``read``, ``mapfile``, ``readarray``,
    ``getopts``, ``printf -v``); None when there is none.

    Args:
        ast (Any): the parsed root node.
        names (frozenset[str]): the variables asked about.
    """
    stack = [ast]
    while stack:
        node = stack.pop()
        name = _sets(node, names)
        if name is not None:
            return node, name
        kids = node.children
        if node.type == NodeType.DECLARATION_COMMAND:
            # The declaration read its assignments' names; only their
            # values are left to walk.
            kids = [
                part
                for kid in kids
                for part in (
                    kid.children
                    if kid.type == NodeType.VARIABLE_ASSIGNMENT
                    else [kid]
                )
            ]
        stack.extend(reversed(kids))
    return None


def _sets(node: Any, names: frozenset[str]) -> str | None:
    """The one of ``names`` a node sets itself (an element of it
    included), None when it sets none. A node setting a variable the gate
    cannot name (a ``declare -n`` nameref, a store into a word only the
    run expands) answers with its command's name.

    Args:
        node (Any): one parsed node.
        names (frozenset[str]): the variables asked about.
    """
    kids = node.children
    if node.type == NodeType.EXPANSION and not any(
        k.type in (":=", "=") for k in kids
    ):
        return None
    if node.type in (
        NodeType.VARIABLE_ASSIGNMENT,
        NodeType.FOR_STATEMENT,
        NodeType.EXPANSION,
    ):
        for kid in kids[:3]:
            if kid.type == NodeType.SUBSCRIPT and kid.children:
                kid = kid.children[0]
            if kid.type == NodeType.VARIABLE_NAME and get_text(kid) in names:
                return get_text(kid)
        return None
    if node.type == NodeType.DECLARATION_COMMAND:
        head = get_text(kids[0]) if kids else ""
        # An assignment is read by its name, the value aside; any other
        # word is a flag or a NAME[=VALUE] the builtin parses at run time.
        words = [
            (
                Word(
                    get_text(k.children[0]) + "=",
                    get_text(k.children[0]) + "=",
                )
                if k.type == NodeType.VARIABLE_ASSIGNMENT
                else Word(get_text(k), get_text(k))
                if k.type == NodeType.VARIABLE_NAME
                else read_word(k, None)
            )
            for k in kids[1:]
        ]
        return _declared(head, words, names)
    if node.type != NodeType.COMMAND:
        return None
    words = _words_of(node, None)
    while words and words[0].value in ("command", "builtin"):
        words = words[1:]
        while words and words[0].value[:1] == "-" and words[0].value != "-":
            option = words[0].value
            words = words[1:]
            if option == "--":
                break
            if "v" in option or "V" in option:
                # `command -v`/`-V` only looks names up.
                return None
    if not words:
        return None
    head = words[0].value
    if head in _DECLARES:
        return _declared(head, words[1:], names)
    if head == "printf":
        words = _printf_target(words[1:])
    elif head in _STORES:
        words = _stored(head, words[1:])
    else:
        return None
    for word in words:
        if word.text is None:
            return head
        if word.text.split("[", 1)[0] in names:
            return word.text.split("[", 1)[0]
    return None


def _declared(
    head: str, words: Sequence[Word], names: frozenset[str]
) -> str | None:
    """The one of ``names`` a declaration builtin's words set, as
    ``_sets`` answers; none when ``declare``, ``typeset`` or ``local``
    only prints (``-p``, ``-f``, ``-F``).

    Args:
        head (str): the builtin, one of ``_DECLARES``.
        words (Sequence[Word]): its words after the name, flags and
            NAME[=VALUE] operands the builtin parses at run time.
        names (frozenset[str]): the variables asked about.
    """
    if head in _NAMEREFS:
        for word in words:
            if word.text is None or word.text[:1] != "-" or word.text == "--":
                break
            if any(flag in word.text for flag in "pfF"):
                return None
    for word in words:
        if word.text is None:
            return head
        if head in _NAMEREFS and word.text[:1] == "-" and "n" in word.text:
            return head
        name = word.text.split("=", 1)[0].split("[", 1)[0]
        if name in names:
            return name
    return None


def _printf_target(args: Sequence[Word]) -> list[Word]:
    """The variable ``printf -v`` stores into, read off its options
    before the format; none when it prints.

    Args:
        args (Sequence[Word]): the words after ``printf``.
    """
    for at, word in enumerate(args):
        if word.text is None:
            # The run may expand it to an option, `-v NAME` among them.
            return [word]
        if word.value[:1] != "-" or word.value in ("-", "--"):
            return []
        if word.value == "-v":
            return list(args[at + 1 : at + 2])
        if word.value.startswith("-v"):
            rest = word.value[2:]
            return [Word(rest, rest)]
    return []


def _stored(head: str, args: Sequence[Word]) -> list[Word]:
    """The words a storing builtin stores into: ``read``'s operands and
    its ``-a`` array, ``mapfile``'s array, ``getopts``'s name after its
    optstring; an option's value is no target.

    Args:
        head (str): the builtin, one of ``_STORES``.
        args (Sequence[Word]): the words after it.
    """
    valued = _STORES[head]
    targets: list[Word] = []
    i = 0
    while i < len(args) and args[i].value[:1] == "-" and args[i].value != "-":
        word = args[i]
        i += 1
        if word.text is None:
            # The run may expand it to options that store into anything.
            return [word]
        if word.value == "--":
            break
        for at, flag in enumerate(word.value[1:], 1):
            if flag not in valued:
                continue
            rest = word.value[at + 1 :]
            value = (
                Word(rest, rest)
                if rest
                else (args[i] if i < len(args) else None)
            )
            if not rest:
                i += 1
            if flag == "a" and value is not None:
                targets.append(value)
            break
    operands = list(args[i:])
    if head == "getopts":
        operands = operands[1:2]
    elif head != "read":
        operands = operands[:1]
    return [*targets, *operands]


def _strictest(places: list[list[Judged]]) -> list[Judged]:
    """What a command is judged to do where it may stand, the strictest
    first: a place where it is refused, then one where it asks, then
    where the walk predicts it stands.

    Args:
        places (list[list[Judged]]): the command's judgments at each
            place, the predicted one first.
    """
    first = [
        next((one for one in judged if one.judgment.exit_code), None)
        for judged in places
    ]
    for refused in (True, False):
        for judged, one in zip(places, first, strict=True):
            if one is not None and _refuses(one.judgment) is refused:
                return judged
    return places[0]


async def line_held(
    judged: list[tuple[Walked, list[Judged]]],
    registry: MountRegistry,
    handed: HandOff,
    cancel: asyncio.Event | None = None,
) -> bool:
    """Whether the line's admission holds it back, which is what
    placement waits on: admission comes first, so a line the rules
    refuse, or that waits on the host, is never shown to a placing
    policy.

    A verdict (:func:`_is_verdict`) that refuses holds the line. A
    question is put to the host now, on the line's hand-off, so the gate
    that later runs the command finds the answer claimed for it and
    does not ask again; one still waiting holds the line, and a question
    the gate will ask about other words (``Judged.stated`` False) is
    left to it. A word a closed tree names nothing for fails where it stands
    while the rest of its line runs, so it does not hold the line.

    Args:
        judged (list[tuple[Walked, list[Judged]]]): the line's read-only
            judgments (:func:`line_judgments`).
        registry (MountRegistry): registry holding the decision ledger.
        handed (HandOff): the line's hand-off, on which an answer given
            here is claimed for the gate.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    for _, explained in judged:
        for one in explained:
            expl = one.judgment
            if not _is_verdict(expl) or expl.exit_code == 0:
                continue
            if _refuses(expl):
                return True
            asked = settled(expl.answers)
            if one.ctx is None or not isinstance(asked, Ask) or not one.stated:
                continue
            action = await resolved(
                one.ctx,
                asked,
                registry,
                cancel,
                Claimant(handed, one.occurrence),
            )
            if action is not None:
                return True
    return False


def holds(judgments: Sequence[Judgment]) -> bool:
    """Whether some command's judgment is a verdict that refuses it or
    waits on the host (:func:`_is_verdict`), the line-level answer
    placement waits on.

    Args:
        judgments (Sequence[Judgment]): a line's judgments.
    """
    return any(_is_verdict(e) and e.exit_code != 0 for e in judgments)


async def explain_line(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    mode: JudgmentMode = JudgmentMode.EXPLAIN,
) -> list[Judged]:
    """What every command of a line would do, in the order the gate
    reads them, each where it stands, without running any of it
    (:func:`explained_line` turns them into the public tree).

    The dry run of the gate: the same visibility check, the same
    context, the same policy chain and the same outcome table, so a
    host reading this and an agent typing the line cannot be told
    different things. What it deliberately does not do is the half of
    admission that costs something, since a line nobody typed must not
    consume a grant or put a question to a host.

    The words are read literally, as ``admit_line`` reads them, so
    nothing is expanded and no ``$( )`` runs.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        mode (JudgmentMode): how this judgment reads the commands and policies.
    """
    return [
        one
        async for one in _judge_line(
            ast,
            session,
            registry,
            namespace,
            root_frame(ast, None),
            mode,
        )
    ]


def explain_redirects(
    ast: Any,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
) -> list[Opened]:
    """Every redirect of a line no command owns that the session's trees
    refuse or ask about, judged where its statement stands, a ``cd``
    before it on the line included, as ``admit_redirect`` judges it when
    the shell opens it, without asking anyone: an ask reads the session's
    standing grants and stops there (``Decisions.held``), as a command's
    does in :func:`_explained`. A target only the runtime can expand
    (``> $f``), or a relative one after a ``cd`` the walk could not
    follow, is left to the run.

    Args:
        ast (Any): the parsed root node.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the decision ledger.
        namespace (Namespace | None): the link table.
    """
    out: list[Opened] = []
    for item in _walked_line(ast, session, opens=True):
        if item.words:
            continue
        at = item.occurrence
        row = encode_text(at.source)[: at.start].count(b"\n") + 1
        voice = f"{voice_name(item.session)}: line {row}: "
        for word in item.redirects:
            if item.lost and not word.value.startswith("/"):
                continue
            targets = redirect_paths([word], registry, item.session.cwd)
            asked = redirect_asked(targets, item.session, namespace)
            if asked is None:
                continue
            answer = asked.answer
            action: Deny | Pending | None = (
                registry.decisions.held(asked.question, answer)
                if isinstance(answer, Ask)
                else answer
            )
            rule = answer.rule
            judgment = Judgment(
                command="",
                argv=asked.question.argv,
                outcome=(
                    Outcome.ASK if isinstance(answer, Ask) else Outcome.DENY
                ),
                rule=rule,
                reason=answer.reason,
                source="" if rule is None else source_of(rule),
                matched_path=asked.named,
                paths=asked.question.argv,
                answers=(answer,),
            )
            if action is not None:
                refusal = redirect_refused(targets, asked.named, action, voice)
                judgment = dataclasses.replace(
                    judgment,
                    exit_code=refusal.exit_code,
                    stderr=decode_text(refusal.stderr),
                    decision=refusal.decision,
                )
            out.append(Opened(judgment, at))
    return out


def explained_line(
    line: str,
    judged: Sequence[Judged],
    verdicts: Sequence[Judged],
    placed_of: Callable[[Judged], str],
    whole_line: bool = False,
    aliases: frozenset[str] = frozenset(),
    opened: Sequence[Opened] = (),
    *,
    session: SessionState,
) -> ShellExplanation:
    """A line's public explanation: its verdict and its parse tree, with
    every command's explanation where the command stands.

    A line the profile's rules hold (:func:`holds`) runs none of it, so
    its verdict is the first command, in the order the gate reads them,
    whose refusal holds it, as the run reports it. A runtime that takes
    the line whole runs none of it once any command is refused
    (:func:`admit_line`), so there every refusal is the line's, and a
    line it runs carries the first ask an approval lets through.

    Otherwise the line runs, and a command refused where it stands (a
    word a closed tree names nothing for, a policy's own
    ``pre_command`` refusal) or a redirect no command owns that its tree
    refuses (``opened``) fails while the rest goes on. The outcome is
    then the strictest of every command and every such redirect, deny
    over ask over allow; the reason, source and decision are the first
    part's that gives it, in line order; the exit code and stderr are
    the run's, read off the line's own control flow
    (:func:`_line_status`), on the assumption that every command let
    through succeeds. A line nothing refuses or asks about exits 0 here,
    since what it returns then is its commands' own business.

    Every scope a command reads its words in (the typed line, a
    ``$( )`` body, a ``bash -c`` string) is parsed on its own, as the
    nested line will be; a judgment is placed on the command at its span
    in that scope, and a nested scope under the command holding it.

    Args:
        line (str): the line as given.
        judged (Sequence[Judged]): :func:`explain_line`'s judgments.
        verdicts (Sequence[Judged]): the judgments the run holds the
            line on: the profile's rules alone (``JudgmentMode.PREPASS``), or
            ``judged`` itself for a runtime that takes the line whole,
            whose gate asks every policy.
        placed_of (Callable[[Judged], str]): the machine that would run
            a command, empty for the workspace.
        whole_line (bool): whether a runtime takes the line whole.
        aliases (frozenset[str]): the alias names the session expands,
            which each scope is parsed with.
        opened (Sequence[Opened]): the line's redirects no command owns
            that its trees refuse or ask about (:func:`explain_redirects`).
        session (SessionState): the shell whose pipeline options are read.
    """
    scopes: dict[tuple[Occurrence | None, str], list[Judged]] = {}
    for one in judged:
        at = one.occurrence
        scopes.setdefault((at.parent, at.source), []).append(one)
    root = next((key for key in scopes if key[0] is None), (None, line))
    node = _scope_node("line", root, scopes, placed_of, aliases)
    # The run holds a line only on a verdict the pass may give on the
    # gate's behalf (``prejudge_line``): a question about words the
    # runtime completes (``find -exec``, ``xargs``) is the gate's, asked
    # where it runs, so it holds nothing here either.
    held = next(
        (
            one
            for one in verdicts
            if one.judgment.exit_code
            and (whole_line or (_is_verdict(one.judgment) and _asks_for(one)))
        ),
        None,
    )
    if held is not None:
        judgment = held.judgment
        outcome, reason, source = _verdict_of(judgment)
        return ShellExplanation(
            line=line,
            node=node,
            outcome=outcome,
            reason=reason,
            source=source,
            decision=judgment.decision,
            exit_code=judgment.exit_code,
            stderr=judgment.stderr,
        )
    if whole_line:
        asked = next(
            (
                one
                for one in verdicts
                if not one.judgment.exit_code
                and _verdict_of(one.judgment)[0] is Outcome.ASK
            ),
            None,
        )
        if asked is None:
            return ShellExplanation(line=line, node=node)
        outcome, reason, source = _verdict_of(asked.judgment)
        return ShellExplanation(
            line=line, node=node, outcome=outcome, reason=reason, source=source
        )
    tree = parse(line, aliases)
    commands: dict[tuple[int, int], list[Judgment]] = {}
    keys: list[tuple[int, int, int] | None] = []
    for one in judged:
        at = one.occurrence
        if at.parent is None:
            listed = commands.setdefault((at.start, at.end), [])
            keys.append((at.start, at.end, len(listed)))
            listed.append(one.judgment)
        else:
            keys.append(None)
    redirects: dict[tuple[int, int], list[Judgment]] = {}
    for open_ in opened:
        at = open_.occurrence
        if at.parent is None:
            redirects.setdefault((at.start, at.end), []).append(open_.judgment)
    traced = _line_status(tree, commands, redirects, session)
    calling = [
        _calls_function(one, key, traced)
        for one, key in zip(judged, keys, strict=True)
    ]
    parts = _in_line_order(
        [one for one, call in zip(judged, calling, strict=True) if not call],
        opened,
    )
    strictest = max(
        (_verdict_of(part)[0] for part in parts),
        key=STRICTNESS.__getitem__,
        default=Outcome.ALLOW,
    )
    if strictest is Outcome.ALLOW:
        return ShellExplanation(line=line, node=node)
    first = next(part for part in parts if _verdict_of(part)[0] is strictest)
    outcome, reason, source = _verdict_of(first)
    return ShellExplanation(
        line=line,
        node=node,
        outcome=outcome,
        reason=reason,
        source=source,
        decision=first.decision,
        exit_code=traced.exit_code,
        stderr="".join(part.stderr for part in traced.ran),
    )


def _calls_function(
    one: Judged, key: tuple[int, int, int] | None, traced: Traced
) -> bool:
    """Whether a judgment is a tree root's own decision about a command
    that calls a function, which no root's own decision speaks for
    (``is_tool``); a rule that names the function still does. The walk
    reads the line before any definition runs, so it judges every such
    call as a tool. A command the fold reached is a call when the
    function was defined where it stands (:class:`Traced`); one in a
    function's body when the function was defined at every call of that
    body; any other, in a substitution or a line a command runs, when
    the function was defined where that command stands.

    Args:
        one (Judged): one command's judgment and place.
        key (tuple[int, int, int] | None): its span and place on the
            typed line, None for one a nested line runs.
        traced (Traced): what the line does.
    """
    if key is not None and key in traced.reached:
        return key in traced.calls
    judgment = one.judgment
    start = _line_start(one.occurrence)
    visible = traced.bodies.get(start, traced.at.get(start, frozenset()))
    return judgment.command in visible and _by_default(judgment)


def _in_line_order(
    judged: Sequence[Judged], opened: Sequence[Opened]
) -> list[Judgment]:
    """Every command's judgment and every unowned redirect's, in the
    order the line reaches them: a command where its statement starts
    on the typed line (one a nested line runs, where the command that
    runs it does), a redirect where the statement it opens for starts,
    since the shell opens it before the statement runs.

    Args:
        judged (Sequence[Judged]): the line's command judgments, in the
            order the gate reads them.
        opened (Sequence[Opened]): the line's unowned redirects.
    """
    placed = [
        (_line_start(one.occurrence), one.judgment) for one in judged
    ] + [(_line_start(open_.occurrence), open_.judgment) for open_ in opened]
    placed.sort(key=lambda pair: pair[0])
    return [judgment for _, judgment in placed]


def _line_start(at: Occurrence) -> int:
    """Where on the typed line a part stands: its own start, or for a
    part a nested line runs, the start of what runs that line.

    Args:
        at (Occurrence): the part's occurrence.
    """
    while at.parent is not None:
        at = at.parent
    return at.start


def _line_status(
    tree: Any,
    commands: Mapping[tuple[int, int], Sequence[Judgment]],
    redirects: Mapping[tuple[int, int], Sequence[Judgment]],
    session: SessionState,
) -> Traced:
    """The exit code a line would return and the refusals it would print
    on the way, read off the line's control flow with every command let
    through taken to succeed: a list returns its last statement's
    status, ``&&`` and ``||`` skip what bash skips, a pipeline returns
    its last stage's (its last failing one under ``pipefail``), ``!``
    inverts a command or a whole pipeline, an ``if`` runs the branch its
    condition picks, a loop its body once when its condition lets it in,
    a ``case`` the arm its word certainly matches (an arm before it
    whose pattern is a glob leaves it unknown, and none runs), a
    statement sent to the background (``&``) 0, and a node whose
    redirect no command owns is refused fails with 1 without running. A
    function definition, a call to a function and the lines a command
    runs in turn (``$( )``, ``bash -c``, ``eval``) answer 0.

    The fold also follows which functions the shell has defined: a
    definition counts once it runs, one in a subshell or a pipeline
    stage or a substitution is gone when that child shell ends, and one
    on a branch the line skips never counts; a function's body sees the
    functions defined at every call of it, and a line a command runs in
    turn the functions defined where that command stands, its own
    substitutions folded as child shells before it. A tree root's own
    decision about a command that calls such a function is no refusal
    (``is_tool``).

    Args:
        tree (Any): the line, parsed.
        commands (Mapping[tuple[int, int], Sequence[Judgment]]): each
            command's judgments on the typed line, by span.
        redirects (Mapping[tuple[int, int], Sequence[Judgment]]): the
            judgments of the redirects no command owns, by the span of
            the node they open for.
        session (SessionState): the shell whose pipeline options are read.
    """
    ran: list[Judgment] = []
    calls: set[tuple[int, int, int]] = set()
    reached: set[tuple[int, int, int]] = set()
    defined: set[str] = set()
    at: dict[int, frozenset[str]] = {}
    starts: dict[str, list[int]] = {}
    seen: dict[str, set[str]] = {}

    def refused(judgments: Sequence[Judgment], runs: bool) -> int:
        first = next((j for j in judgments if j.exit_code), None)
        if first is None or not runs:
            return 0
        ran.append(first)
        return first.exit_code

    pipeline = _pipeline_walk()
    homes = tilde_homes(session)
    # The status fold uses the session's pipefail at line entry.
    pipefail = session.shell_options.get("pipefail", False)

    def forked(
        node: Any, runs: bool, *, body: bool = False, background: bool = False
    ) -> int:
        nonlocal pipeline
        kept = set(defined)
        outer = pipeline
        pipeline = dataclasses.replace(outer, background=background)
        try:
            return (
                statements(node.children, runs) if body else status(node, runs)
            )
        finally:
            pipeline = outer
            defined.clear()
            defined.update(kept)

    def statements(nodes: Sequence[Any], runs: bool) -> int:
        code = 0
        for node in nodes:
            if not node.is_named or node.type in INERT:
                continue
            if is_backgrounded(node):
                forked(node, False, background=background_pipeline(node))
                code = 0
            else:
                code = status(node, runs)
        return code

    def command(span: tuple[int, int], runs: bool) -> int:
        kept: list[Judgment] = []
        for place, judgment in enumerate(commands.get(span, ())):
            key = (*span, place)
            reached.add(key)
            if judgment.command in defined and _by_default(judgment):
                calls.add(key)
                if judgment.command in seen:
                    seen[judgment.command] &= defined
                else:
                    seen[judgment.command] = set(defined)
            else:
                kept.append(judgment)
        return refused(kept, runs)

    def status(node: Any, runs: bool) -> int:
        kind = node_kind(node)
        scope = scope_kind(node, kind)
        span = (node.start_byte, node.end_byte)
        at.setdefault(node.start_byte, frozenset(defined))
        code = refused(redirects.get(span, ()), runs)
        if code:
            return code
        if kind in (NodeKind.COMMAND, NodeKind.TEST):
            for sub in _substitutions(node.children):
                status(sub, runs)
            code = command(span, runs)
            if kind == NodeKind.COMMAND and not pipeline.options_may_change:
                head = next(
                    (
                        c
                        for c in node.named_children
                        if c.type == NodeType.COMMAND_NAME
                    ),
                    None,
                )
                name = None if head is None else literal_word(head)
                if (
                    head is not None
                    and name is None
                    or name in session.functions
                    or name in pipeline.functions
                    or name in ("shopt", "set", "command", "builtin")
                ):
                    pipeline.options_may_change = _changes_pipeline_options(
                        _words_of(node, homes), session, pipeline
                    )
            return code
        if kind == NodeKind.REDIRECT:
            for sub in _substitutions(node.named_children[1:]):
                status(sub, runs)
            body = node.named_children[:1]
            if not body or body[0].type in REDIRECT_TYPES:
                return 0
            return status(body[0], runs)
        if kind == NodeKind.LIST:
            left, op, right = (
                node.children[0],
                node.children[1],
                node.children[-1],
            )
            code = status(left, runs)
            goes = connection_runs_right(op.type, code)
            later = status(right, runs and goes)
            return later if goes else code
        if scope == ScopeKind.PIPELINE:
            stages = list(node.named_children)
            negated = (
                bool(stages) and stages[0].type == NodeType.NEGATED_COMMAND
            )
            if negated:
                stages[0] = stages[0].named_children[-1]
            codes = [
                forked(stage, runs)
                if _stage_forks(index == len(stages) - 1, session, pipeline)
                else status(stage, runs)
                for index, stage in enumerate(stages)
            ]
            if pipefail:
                code = next((c for c in reversed(codes) if c), 0)
            else:
                code = codes[-1] if codes else 0
            return (0 if code else 1) if negated else code
        if kind == NodeKind.NEGATED:
            return 0 if statements(node.children, runs) else 1
        if scope in (ScopeKind.FORK, ScopeKind.SUBSTITUTION):
            return forked(node, runs, body=True)
        if kind == NodeKind.IF:
            branches, else_body = get_if_branches(node)
            code = 0
            taken = False
            for head, body in branches:
                live = runs and not taken
                hit = statements(head, live) == 0 and live
                result = statements(body, hit)
                if hit:
                    code, taken = result, True
            if else_body is not None:
                live = runs and not taken
                result = statements(else_body, live)
                if live:
                    code = result
            return code
        if scope == ScopeKind.REPEATED and kind in (
            NodeKind.WHILE,
            NodeKind.UNTIL,
        ):
            loop = [
                c for c in node.named_children if c.type == NodeType.DO_GROUP
            ]
            head = [c for c in node.children if c.type != NodeType.DO_GROUP]
            until = kind == NodeKind.UNTIL
            entered = runs and (statements(head, runs) == 0) != until
            code = statements(loop, entered)
            return code if entered else 0
        if scope == ScopeKind.DEFERRED:
            name = get_function_name(node)
            pipeline.functions |= {name}
            if runs:
                defined.add(name)
                starts.setdefault(name, []).append(node.start_byte)
            return 0
        if kind == NodeKind.CASE:
            arm = _case_arm(node)
            code = 0
            for index, (_, body, _) in enumerate(get_case_items(node)):
                hit = runs and index == arm
                result = statements(body, hit)
                if hit:
                    code = result
            return code
        if scope == ScopeKind.REPEATED:
            loop = [
                c for c in node.named_children if c.type == NodeType.DO_GROUP
            ]
            return statements(loop, runs)
        return statements(node.children, runs)

    code = status(tree, True)
    return Traced(
        code,
        tuple(ran),
        frozenset(calls),
        frozenset(reached),
        at,
        {
            start: frozenset(seen.get(name, ()))
            for name, places in starts.items()
            for start in places
        },
    )


def _substitutions(nodes: Sequence[Any]) -> list[Any]:
    """The outermost substitutions (``$( )``, ``<( )``) among a command's
    words or a statement's redirects, which run, each in a child shell,
    before the command does.

    Args:
        nodes (Sequence[Any]): the words or redirects, parsed.
    """
    found: list[Any] = []
    for node in nodes:
        if scope_kind(node) == ScopeKind.SUBSTITUTION:
            found.append(node)
        else:
            found.extend(_substitutions(node.children))
    return found


def _case_arm(node: Any) -> int | None:
    """The arm of a ``case`` its word certainly matches: the first whose
    pattern is the word itself or a bare ``*``, when the word is literal
    and no arm before it holds a pattern only the shell's matcher can
    decide (a glob, a quote, an expansion). None when no arm is certain.

    Args:
        node (Any): the ``case_statement``.
    """
    word = literal_word(get_case_word(node))
    if word is None:
        return None
    for index, (patterns, _, _) in enumerate(get_case_items(node)):
        for pattern in patterns:
            text = get_text(pattern)
            if text == "*" or text == word:
                return index
            if any(mark in text for mark in "*?[]\\'\"$`"):
                return None
    return None


def _refusal(answers: tuple[Deny | Ask | Route, ...]) -> Deny | Ask | None:
    """What a command's answers come to as the gate reads them: the
    first Deny (two routes that disagree among them), else the first
    Ask; a route the answers agree on refuses nothing.

    Args:
        answers (tuple[Deny | Ask | Route, ...]): the command's answers.
    """
    verdict = settled(answers)
    return None if isinstance(verdict, Route) else verdict


def _verdict_of(judgment: Judgment) -> tuple[Outcome, str, str]:
    """A command's outcome, reason and source as its explanation states
    them: the refusal it meets (``ASK`` for a question waiting on the
    host, ``DENY`` for any other, a policy that failed included), else
    the ask an approval lets through, else ``DENY`` for a command no
    tree names. The reason and source are the deciding answer's,
    which a coded policy may give over the document's own.

    Args:
        judgment (Judgment): the command's judgment.
    """
    decider = _refusal(judgment.answers)
    if decider is not None and decider.rule is not None:
        source = source_of(decider.rule)
    else:
        source = "commands" if judgment.source == "commands" else ""
    refused = judgment.decision
    if refused is not None:
        outcome = Outcome.ASK if is_pending(refused) else Outcome.DENY
        return outcome, refused.reason, source
    if isinstance(decider, Ask):
        return Outcome.ASK, decider.reason, source
    if judgment.exit_code:
        return Outcome.DENY, "", source
    return Outcome.ALLOW, "", source


def _scope_node(
    kind: str,
    key: tuple[Occurrence | None, str],
    scopes: dict[tuple[Occurrence | None, str], list[Judged]],
    placed_of: Callable[[Judged], str],
    aliases: frozenset[str],
) -> ShellNode:
    """One scope of a line as a node: its text parsed, the commands
    judged in it placed by span, and the scopes evaluated from it placed
    under the command holding them.

    Args:
        kind (str): ``line`` or ``substitution``.
        key (tuple[Occurrence | None, str]): the scope: the occurrence
            its text was evaluated from, and the text.
        scopes (dict[tuple[Occurrence | None, str], list[Judged]]): every
            scope's judgments.
        placed_of (Callable[[Judged], str]): the machine that would run
            a command.
        aliases (frozenset[str]): the alias names each scope is parsed
            with.
    """
    parent, text = key
    mine: dict[tuple[int, int], list[Judged]] = {}
    for one in scopes.get(key, []):
        mine.setdefault((one.occurrence.start, one.occurrence.end), []).append(
            one
        )
    nested: list[tuple[Occurrence, tuple[Occurrence | None, str]]] = []
    for other in scopes:
        at = other[0]
        if at is not None and at.parent == parent and at.source == text:
            nested.append((at, other))
    nested.sort(key=lambda pair: (pair[0].start, pair[0].end))

    def take(start: int, end: int) -> list[ShellNode]:
        inside = [
            pair
            for pair in nested
            if start <= pair[0].start and pair[0].end <= end
        ]
        for pair in inside:
            nested.remove(pair)
        return [
            _scope_node(
                "line"
                if (at.start, at.end) == (start, end)
                else "substitution",
                other,
                scopes,
                placed_of,
                aliases,
            )
            for at, other in inside
        ]

    def convert(node: Any) -> list[ShellNode | CommandExplanation]:
        start, end = node.start_byte, node.end_byte
        if node.type in (NodeType.COMMAND, NodeType.TEST_COMMAND):
            kids = tuple(take(start, end))
            ones = mine.pop((start, end), [])
            if not ones:
                return [ShellNode("command", get_text(node), kids)]
            return [
                _command_of(
                    one, get_text(node), kids if i == 0 else (), placed_of
                )
                for i, one in enumerate(ones)
            ]
        if scope_kind(node) == ScopeKind.SUBSTITUTION:
            return list(take(start, end))
        inner = [
            part for child in node.named_children for part in convert(child)
        ]
        shape = SHAPES.get(node.type)
        if shape is None:
            return inner
        return [ShellNode(shape, get_text(node), tuple(inner))]

    children: list[ShellNode | CommandExplanation] = convert(
        parse(text, aliases)
    )
    # The shell's own spelling: a scope's text can carry a byte no UTF-8
    # encodes (`env` running `$'\xff'`), and the offsets are the
    # parser's, counted on these bytes.
    raw = encode_text(text)
    for (start, end), ones in mine.items():
        spoken = decode_text(raw[start:end])
        children.extend(
            _command_of(one, spoken, (), placed_of) for one in ones
        )
    children.extend(take(0, len(raw)))
    return ShellNode(kind, text, tuple(children))


def _command_of(
    one: Judged,
    text: str,
    children: tuple[ShellNode, ...],
    placed_of: Callable[[Judged], str],
) -> CommandExplanation:
    """One command's public explanation.

    Args:
        one (Judged): the command's judgment and place.
        text (str): its source text.
        children (tuple[ShellNode, ...]): the scopes it runs in turn.
        placed_of (Callable[[Judged], str]): the machine that would run
            it, empty for the workspace.
    """
    judgment = one.judgment
    outcome, reason, source = _verdict_of(judgment)
    machine = placed_of(one)
    return CommandExplanation(
        command=judgment.command,
        words=judgment.words,
        exit_code=judgment.exit_code,
        stderr=judgment.stderr,
        outcome=outcome,
        reason=reason,
        source=source,
        answers=judgment.answers,
        decision=judgment.decision,
        machine=machine,
        text=text,
        children=children,
    )

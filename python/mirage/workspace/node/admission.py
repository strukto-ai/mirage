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
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from mirage.commands.cli.walk import walk
from mirage.commands.spec.types import ValueType
from mirage.context.session_context import session_access
from mirage.io.types import ByteSource
from mirage.policy import (
    Abandoned,
    AdmissionRules,
    Ask,
    Claimant,
    CommandContext,
    CommandRule,
    CommandWord,
    Deny,
    Pending,
    Scope,
    ask_rule,
    policy_denied,
    refusal_of,
    render_deny,
)
from mirage.policy.builtin.permissions import PermissionsPolicy
from mirage.policy.match import (
    Outcome,
    io_reach,
    io_refusal,
    line_tokens,
    pattern_matches,
    split_pattern,
)
from mirage.policy.policies import settled
from mirage.shell.helpers import (
    get_redirects,
    literal_word,
)
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec, Refusal
from mirage.utils.abort import MirageAbortError
from mirage.utils.filetype import get_extension
from mirage.utils.hidden import path_visible
from mirage.utils.path import resolve_path
from mirage.view.types import NamespaceLinks
from mirage.workspace.executor.builtins.condition.operands import (
    TEST_NAMES,
    file_operands,
)
from mirage.workspace.executor.builtins.condition.types import CondRefused
from mirage.workspace.executor.builtins.links.links import follow_paths
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.command.cli import reaches_service
from mirage.workspace.executor.command.routing import (
    CWD_DEFAULT_RAW,
    command_tree,
    command_words,
    default_cwd_operand,
    merge_scopes,
    path_flag_scopes,
    program_tokens,
    routable_scopes,
    routed_operands,
    tree_path_scopes,
)
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.expand.spec_hints import (
    spec_for_command,
    spec_word_bases,
    spec_word_kinds,
)
from mirage.workspace.lookup import (
    SLASH_KEEPS_LAST,
    Consumer,
    WordPolicy,
    changes_files,
    follows_last_component,
    is_tool,
    line_flags,
    lookup,
    runs_as,
    walks_mounts,
    word_policy,
)
from mirage.workspace.lookup.constants import (
    INTERPRETER_NAMES,
    WRITING_PROGRAMS,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.inner_lines import (
    Word,
)
from mirage.workspace.session import SessionState, env_snapshot

# The nodes a redirected statement may wrap whose last command is the
# one the redirect binds to. A `!` wraps one command, so it is its own
# last one: `! cat < f` parses as redirected(negated(cat), < f).
REDIRECT_CHAIN = frozenset({NT.LIST, NT.PIPELINE, NT.NEGATED_COMMAND})


@dataclass(frozen=True, slots=True)
class Refused:
    """What the command plane prints when a line does not get to run.

    Args:
        stderr (bytes): the message, newline-terminated.
        exit_code (int): 126 for a whole-command refusal or an
            unanswered ask, the operand code (1, tar 2) for a refusal
            about a path or carrying an error.
        refusal (Refusal | None): the record the result carries
            beside stderr; None for the filesystem's own error.
    """

    stderr: bytes
    exit_code: int
    refusal: Refusal | None = None


def _norm(virtual: str) -> str:
    return virtual.rstrip("/") or "/"


@dataclass(frozen=True, slots=True)
class Admitted:
    """A command the gate let through, and what its own I/O may touch.

    The gate judged the paths the line names; a walk below them
    reaches entries no rule has seen, so the dispatcher binds this to
    the session context for the command's run and the commands tier
    asks it before each read, write or listing (``EntryGate``). The
    paths the gate already judged pass, since the line was admitted on
    them; every other entry is judged by ``io_refusal`` under the same
    precedence the gate applied to the line, and a refusal is the
    dispatcher's ``PolicyDenied`` (EACCES, the path, the reason on its
    record), which every command renders as GNU's ``Permission
    denied``.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        ctx (CommandContext): what ``pre_command`` judged the command on,
            which ``post_command`` extends with what came back.
        judged (frozenset[str]): the virtual paths the gate judged.
        granted (tuple[CommandRule, ...]): the ask rules the line runs
            under a grant for: the one the entry point answered for this
            line, and the session's standing ones.
    """

    rules: AdmissionRules | None
    ctx: CommandContext
    judged: frozenset[str]
    granted: tuple[CommandRule, ...]

    def scopes(self, virtual: str) -> bool:
        """Whether anything at or under this path could be refused for
        the running command: a rule in force at any path its scope could
        cover. The dispatcher checks coded file policies separately.

        Args:
            virtual (str): absolute virtual path of a walk's start point.
        """
        return io_reach(self.rules, self.ctx.tokens, virtual)

    def check(self, virtual: str) -> None:
        """Raise ``PolicyDenied`` when a rule in force refuses this entry
        for the running command.

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        reason = self.refusal(virtual)
        if reason is not None:
            raise policy_denied(
                Deny(reason, policy=PermissionsPolicy.__name__), virtual
            )

    def refusal(self, virtual: str) -> str | None:
        """The reason a rule in force refuses this entry, None when the
        line was admitted on it or nothing refuses it.

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        if _norm(virtual) in self.judged:
            return None
        return io_refusal(self.rules, self.ctx.tokens, virtual, self.granted)


def policy_scopes(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    links: NamespaceLinks | None,
    cwd: str,
    implied: PathSpec | None = None,
    redirects: Sequence[PathSpec] = (),
    tree_flags: Sequence[PathSpec] = (),
) -> list[PathSpec]:
    """The paths a path-pattern guard reads for a line.

    The operands as typed and the values of path-valued flags, a command
    tree's group and leaf options among them, then, for
    a command that follows links, the targets they resolve to: ``cat
    /data/link`` reads ``/data/secret``, so a rule protecting the target
    has to see it, and a command-scoped rule never runs at the dispatcher
    where the resolved path would otherwise be checked. The follow
    policy is the command's own (``follows_last_component``: ``rm``,
    ``mv``, ``ln``, ``stat``, ``tar`` ... act on the link itself, ``-L``
    turns following back on), the same one the router applies to the
    operands before the handler runs, so a rule sees exactly the path
    the command will touch. A loop is left to that later step to
    report; here the typed paths stand. Then the operand a bare
    ``ls``/``find``/``du``/``tree``/``grep -r`` implies, the working
    directory, which the executor injects after the gate and which a
    rule on that directory has to see. Last come the statement's
    redirect targets: ``cat < /data/secret`` reads the file and ``echo
    x > /data/secret`` truncates it, on the shell's own fds outside the
    admitted command's gate window, so the admission is the one place a
    rule can see them. A redirect always dereferences (the shell opens
    the target), so its link targets ride along whatever the command's
    own follow policy says.

    Args:
        name (str): command name.
        args (list[str]): the words after it, as typed.
        operands (Sequence[str | PathSpec]): the same words, classified.
        links (NamespaceLinks | None): the session's link table
            (``Namespace.session_links``); None where no link stands.
        cwd (str): session working directory.
        implied (PathSpec | None): the working-directory operand the
            command reads when typed bare, None when it names a path.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
        tree_flags (Sequence[PathSpec]): the path-valued options a
            command tree's walk resolves (``tree_path_scopes``), empty
            for a command with no tree.
    """
    scopes = [p for p in operands if isinstance(p, PathSpec)]
    scopes.extend(path_flag_scopes(name, args, cwd))
    typed = {p.virtual for p in scopes}
    scopes.extend(p for p in tree_flags if p.virtual not in typed)
    if "/" in name:
        # A slash-carrying head word is a file the line executes, and it
        # lives in argv[0], not the operands, so a path-pattern guard
        # would never see it without this row.
        scopes.insert(0, _to_scope(resolve_path(name, cwd)))
    if links is not None and operands:
        followed = follow_paths(
            links,
            list(operands),
            follows_last_component(name, [name, *args]),
            slash_follows=name not in SLASH_KEEPS_LAST,
        )
        seen = {p.virtual for p in scopes}
        for item in followed:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)
    if implied is not None and implied.virtual not in {
        p.virtual for p in scopes
    }:
        scopes.append(implied)
    if redirects:
        targets: list[str | PathSpec] = list(redirects)
        if links is not None:
            followed = follow_paths(links, list(redirects), True)
            targets.extend(p for p in followed if isinstance(p, PathSpec))
        seen = {p.virtual for p in scopes}
        for item in targets:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)
    return scopes


def _seen(
    session: SessionState,
    specs: list[PathSpec],
    unread: frozenset[str] = frozenset(),
) -> tuple[PathSpec, ...]:
    """The paths of a line the session can see.

    A hidden path is nonexistent for the session, so no policy may
    learn of it either: a rule scoped to it must not fire (the reason
    would say the path is there), an ask must not be raised for it (a
    request would name it to the host), and the line runs on to the
    dispatcher, which answers ENOENT like any other absent path. A path the
    reader could not read goes the same way, since the line may never
    name it.

    Args:
        session (SessionState): the session running the line.
        specs (list[PathSpec]): the paths as the gate collected them.
        unread (frozenset[str]): virtual paths the reader cannot vouch
            for, as ``gate`` takes them.
    """
    return tuple(
        p
        for p in specs
        if p.virtual not in unread
        and path_visible(session.visibility, p.virtual)
    )


def _seen_words(
    session: SessionState,
    words: tuple[CommandWord, ...],
    unread: frozenset[str],
) -> tuple[CommandWord, ...]:
    """The words a policy is shown, a path ``_seen`` drops taken off the
    word that names it, so a policy reads the word and never the path.

    Args:
        session (SessionState): the session running the line.
        words (tuple[CommandWord, ...]): the command's words.
        unread (frozenset[str]): virtual paths the reader cannot vouch
            for, as ``gate`` takes them.
    """
    shown = {
        p.virtual
        for p in _seen(
            session, [w.path for w in words if w.path is not None], unread
        )
    }
    return tuple(
        w
        if w.path is None or w.path.virtual in shown
        else dataclasses.replace(w, path=None)
        for w in words
    )


def unlisted_service(
    ctx: CommandContext, registry: MountRegistry, session: SessionState
) -> bool:
    """Whether the allow list refuses a CLI that reaches a service.

    Such a CLI (an account or script CLI) reaches its service by id, past
    every hide, so under a profile that hides paths it runs only where a
    pattern starting with its own name matches the line. ``*`` and a
    pattern for another of its verbs do not count.

    Args:
        ctx (CommandContext): the classified command.
        registry (MountRegistry): the registry holding the CLIs.
        session (SessionState): the session running the line.
    """
    install = registry.clis.get(ctx.command)
    if (
        not ctx.tool
        or install is None
        or not reaches_service(install.cli)
        or session.visibility.paths is None
    ):
        return False
    tokens = line_tokens(ctx)
    rules = session.commands
    return not any(
        split_pattern(p)[:1] == (ctx.command,) and pattern_matches(p, tokens)
        for p in (rules.allow if rules is not None else None) or ()
    )


def _writes(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    implied: PathSpec | None,
) -> bool:
    """Whether the handler a command resolves to declares that it may
    change state.

    A command tree's leaf (an installed CLI's, or a tree a mount serves)
    as its walk names it, under the session environment its run walks
    with, which fills a group option declaring ``Argument.env``; any
    other mount command as every handler a run of it may reach: on the
    mount that would run it (the mount of the first path the line names,
    else of the working directory), on each path's own mount, which a run
    across mounts hands that path, and on every mount below a path, which
    a walk reaches. Its handler is picked by an operand's extension, so
    each path's counts, and a run follows links before it picks either,
    so a link's target counts beside its name. Mirage's own handler
    counts only when the line's options let it write (``changes_files``:
    ``sort -o`` writes, ``sort`` does not). A namespace or routed
    program that changes what it names (``WRITING_PROGRAMS``: ``ln``,
    ``chmod`` ...) writes by name.
    A walk the tree refuses runs nothing, and a shell builtin, a function,
    an external program or an unknown name declares nothing.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the mounts and the
            CLI installs.
        namespace (Namespace | None): the link table; None outside a
            workspace.
        implied (PathSpec | None): the working-directory operand a bare
            command reads.
    """
    consumer = lookup(name, session, registry)
    if name in WRITING_PROGRAMS and consumer in (
        Consumer.NAMESPACE,
        Consumer.MOUNT,
    ):
        return True
    if consumer is not Consumer.CLI and consumer is not Consumer.MOUNT:
        return False
    tree = command_tree(registry, name, session.cwd, args)
    if tree is not None:
        trees = [tree]
        if consumer is Consumer.MOUNT:
            candidates = registry.invocation_candidates(
                name, [], session.cwd, args, session_access(session)
            )
            trees = []
            for mount in candidates:
                candidate_tree = mount.cli_for(name)
                if candidate_tree is not None:
                    trees.append(candidate_tree)
                elif mount.may_write(name):
                    return True
        for candidate_tree in trees:
            result = walk(
                name,
                candidate_tree.spec,
                args,
                session.cwd,
                env_snapshot(session),
            )
            if (
                result.leaf is not None
                and candidate_tree.handlers[" ".join(result.path)].write
            ):
                return True
        return False
    runs = runs_as(name, registry)
    # The words that route the run, picked as execution picks them: a
    # stdin `-` and an assignment route nowhere, and a path-valued option,
    # attached or not, routes like an operand.
    named = [
        s
        for s in merge_scopes(
            routable_scopes(
                runs,
                routed_operands(
                    runs,
                    args,
                    session.cwd,
                    list(operands),
                    [p for p in operands if isinstance(p, PathSpec)],
                ),
            ),
            path_flag_scopes(runs, args, session.cwd),
        )
        if s.walk_error != "ENOENT"
    ]
    if namespace is not None and namespace.nodes and named:
        typed = {p.virtual for p in named}
        named += [
            p
            for p in follow_paths(
                namespace.session_links(session),
                list(named),
                follows_last_component(name, [name, *args]),
                slash_follows=name not in SLASH_KEEPS_LAST,
            )
            if isinstance(p, PathSpec) and p.virtual not in typed
        ]
    scopes = named or ([implied] if implied is not None else [])
    reached = registry.invocation_candidates(
        runs, scopes[:1], session.cwd, args, session_access(session)
    )
    for scope in scopes:
        owner = registry.try_mount_for(scope.virtual)
        below = scope.virtual.rstrip("/") + "/"
        reached += [
            m
            for m in registry.mounts()
            if m is owner or m.prefix.startswith(below)
        ]
    extensions = {get_extension(p.virtual) for p in named} or {None}
    builtins = changes_files(runs, [runs, *operands])
    for mount in reached:
        candidate_tree = mount.cli_for(runs)
        if candidate_tree is not None:
            result = walk(
                runs,
                candidate_tree.spec,
                args,
                session.cwd,
                env_snapshot(session),
            )
            if (
                result.leaf is not None
                and candidate_tree.handlers[" ".join(result.path)].write
            ):
                return True
        elif any(
            mount.may_write(runs, extension, builtins)
            for extension in extensions
        ):
            return True
    return False


async def gate(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    stdin: ByteSource | None = None,
    redirects: Sequence[PathSpec] = (),
    intrinsic: bool = False,
    unread: frozenset[str] = frozenset(),
    every: bool = False,
    rules_only: bool = False,
    line: str = "",
) -> tuple[CommandContext, Deny | Ask | None, tuple[Deny | Ask, ...]]:
    """Everything the gate decides about one command before anything is
    spent on it: the classified context, and the policy chain's answer
    with the answers it came from.

    Split out of :func:`admit` so a dry run can have the answer without
    the consequences. Nothing here records a request, consumes a grant
    or reaches the host, which is what makes it safe for
    ``explain``; :func:`admit` adds exactly those and renders.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies and the
            CLI installs.
        namespace (Namespace | None): the link table.
        stdin (ByteSource | None): the line's stdin, which decides
            whether a bare ``rg`` reads the working directory.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
        intrinsic (bool): judge a shell-provided operation as a tool even
            when a function shadows its policy name.
        unread (frozenset[str]): virtual paths a reader of the line's
            text cannot vouch for: what a word only the runtime expands
            names, or a relative word after a ``cd`` it could not
            follow. No policy is shown them; the per-command gate reads
            the real ones and passes none.
        every (bool): ask every policy past a Deny, for ``explain``;
            the gate's own answers end at the first Deny.
        rules_only (bool): ask the profile's rules alone, for a pass
            that judges a line before it runs; a policy's own
            ``pre_command`` is asked once, by the gate that runs the
            command.
        line (str): the line the command was parsed from, empty
            outside a line.

    Returns:
        The context, the chain's answer (the first Deny, else the first
        Ask) and every answer it came from.
    """
    tool = intrinsic or is_tool(name, session)
    env = env_snapshot(session)
    tokens, program = program_tokens(registry, name, args, session.cwd, env)
    implied = (
        default_cwd_operand(
            [name, *operands], name, registry, session.cwd, stdin
        )
        if name in CWD_DEFAULT_RAW
        else None
    )
    # The methods read the session this command is judged in, which for a
    # line explain walks is the walked one, not the stored one.
    views = registry.policies.views
    handles = (
        views(session.session_id, session)
        if views is not None and not rules_only
        else None
    )
    view, vfs, caller = handles or (None, None, None)
    ctx = CommandContext(
        command=name,
        paths=_seen(
            session,
            policy_scopes(
                name,
                args,
                operands,
                (
                    namespace.session_links(session)
                    if namespace is not None and namespace.nodes
                    else None
                ),
                session.cwd,
                implied,
                redirects,
                tree_path_scopes(registry, name, args, session.cwd, env),
            ),
            unread,
        ),
        words=_seen_words(
            session,
            command_words(
                registry, name, args, operands, redirects, session.cwd, env
            ),
            unread,
        ),
        argv=tuple(args),
        cwd=session.cwd,
        line=line,
        session_id=session.session_id,
        tokens=tokens,
        program=program,
        tool=tool,
        walks=walks_mounts(name, line_flags(name, [name, *args])),
        write=_writes(
            name, args, operands, session, registry, namespace, implied
        ),
        session=view,
        vfs=vfs,
        caller=caller,
    )
    said = await registry.policies.answers(
        "pre_command", ctx, every, rules_only
    )
    answers = tuple(a for a in said if isinstance(a, (Deny, Ask)))
    if unlisted_service(ctx, registry, session):
        refused = Deny(
            f"{' '.join(program)} is not allowed",
            policy=PermissionsPolicy.__name__,
        )
        answers = (refused, *answers)
    return ctx, settled(answers), answers


async def resolved(
    ctx: CommandContext,
    asked: Deny | Ask | None,
    registry: MountRegistry,
    cancel: asyncio.Event | None,
    claimant: Claimant | None,
) -> Deny | Pending | None:
    """The chain's answer once the ledger has had its say.

    An Ask is the chain's answer only after every Deny had its say; the
    ledger answers it from the session's records or the host, so an
    answer never re-opens a deny. A wait the run's kill cut short is the
    kill landing late, not a ruling, so it raises as every other
    abandoned wait does rather than being rendered as a refusal the
    document never made.

    Args:
        ctx (CommandContext): the context the chain was shown.
        asked (Deny | Ask | None): what the chain answered.
        registry (MountRegistry): registry holding the decision ledger.
        cancel (asyncio.Event | None): the run's kill channel.
        claimant (Claimant | None): the command and its line, as
            ``admit`` takes it.
    """
    if not isinstance(asked, Ask):
        return asked
    action = await registry.decisions.resolve(ctx, asked, cancel, claimant)
    if isinstance(action, Abandoned):
        raise MirageAbortError()
    return action


async def admit(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    stdin: ByteSource | None = None,
    redirects: Sequence[PathSpec] = (),
    cancel: asyncio.Event | None = None,
    claimant: Claimant | None = None,
    intrinsic: bool = False,
    unread: frozenset[str] = frozenset(),
    rules_only: bool = False,
) -> Refused | Admitted:
    """The command plane's admission of one command: the policy chain,
    then the decision ledger.

    The one gate every command class passes through, in the tree
    (``_run_argv``, once the words are expanded) and for a line a
    runtime takes whole (``admit_line``, per parsed command). A word
    the session's allow list leaves out is the profile's Deny, like any
    other rule's; a path the session cannot see is dropped before any
    method, so a rule never names it and the dispatcher answers ENOENT; a Deny
    renders in the outcome table's voice; an Ask is answered by the
    entry point from the session's grants or the host. A command that gets
    through comes back as its ``Admitted`` gate, which its own I/O
    consults for the entries the gate did not see.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        stdin (ByteSource | None): the line's stdin, which decides
            whether a bare ``rg`` reads the working directory.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
        cancel (asyncio.Event | None): the run's kill channel, carried
            only so a question put to a host cannot outlive the run
            that raised it. Nothing else here waits on anything outside
            mirage.
        intrinsic (bool): the shell provides the operation directly, so
            a function of the same name cannot bypass its tool allow list.
        claimant (Claimant | None): the command and its line, None
            outside a line. On a line, every grant behind the command
            is claimed on the line's hand-off for that occurrence,
            whether a pass that judges the line before it runs
            (``prejudge_line``, ``admit_line``) or the gate that runs
            it is reading, and spent when the line ends, so one
            question covers one run rather than one reader; a reader
            outside a line spends what it matched. A refusal needs no
            such care -- the record refuses the agent's retry from the
            ledger either way.
        unread (frozenset[str]): paths no policy is shown, as ``gate``
            takes them.
        rules_only (bool): ask the profile's rules alone, as ``gate``
            takes it.
    """
    gated = await gate(
        name,
        args,
        operands,
        session,
        registry,
        namespace,
        stdin,
        redirects,
        intrinsic=intrinsic,
        unread=unread,
        rules_only=rules_only,
        line=claimant.occurrence.source if claimant is not None else "",
    )
    ctx, asked, _ = gated
    action = await resolved(ctx, asked, registry, cancel, claimant)
    if action is None:
        granted = [
            r.rule
            for r in session.decisions
            if r.scope is Scope.SESSION and r.outcome is Outcome.ALLOW
        ]
        if isinstance(asked, Ask):
            granted[:0] = asked.rules or (ask_rule(ctx, asked),)
        return Admitted(
            rules=session.commands,
            ctx=ctx,
            judged=frozenset(_norm(p.virtual) for p in ctx.paths),
            granted=tuple(granted),
        )
    err, code = render_deny(name, action)
    return Refused(err, code, refusal_of(action))


async def admit_test(
    name: str,
    words: list[str],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace | None,
    cancel: asyncio.Event | None = None,
    claimant: Claimant | None = None,
) -> Admitted:
    """Admit a ``[ ]`` test, or one ``[[ ]]`` leaf, as the command it
    is: the shell evaluates it itself, so no command gate saw its words,
    and a rule, an allow list or a policy answers it by its own name as
    it answers ``test`` on the same words.

    Args:
        name (str): ``[`` or ``[[``.
        words (list[str]): what it tests, expanded, operators included.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        cancel (asyncio.Event | None): the run's kill channel.
        claimant (Claimant | None): the test and its line, None outside
            a line.

    Raises:
        CondRefused: the gate refused it.
    """
    classified = classified_words(name, words, session, registry)
    verdict = await admit(
        name,
        words,
        classified[1:],
        session,
        registry,
        namespace,
        cancel=cancel,
        claimant=claimant,
        intrinsic=True,
    )
    if isinstance(verdict, Refused):
        raise CondRefused(verdict.stderr, verdict.exit_code, verdict.refusal)
    return verdict


def _word_hints(
    line: list[str], session: SessionState, registry: MountRegistry
) -> tuple[list[ValueType | None] | None, list[str | None] | None]:
    """The spec's per-position classification hints for a literal line,
    the way ``expand_argv`` computes them for an expanded one.

    Without them a bare filename operand stays text (``cat secret``
    from ``/data`` yields no ``/data/secret`` scope) and a chdir option
    (tar's ``-C``) resolves later words against the wrong base, so a
    rule and the run would disagree about the paths the line names.

    A mount command's spec is read, and so is a native capture's and an
    interpreter's: ``python3 steal.py`` runs on the runtime's own disk
    or a host process, where no dispatcher follows the read, so the
    script slot the spec declares is the one place a path rule can see
    the file. The tree's gate reads a native capture the same way
    (``expand_argv``), and an interpreter it runs itself for the script
    slot alone, since its other words become the program's argv there;
    here the hints reach no runtime word, since the line runs as typed,
    so there is nothing to lose by reading them all.

    Args:
        line (list[str]): the literal words, name first.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the specs.
    """
    consumed = registry.match_command_prefix(line)
    joined = " ".join(line[:consumed])
    if joined in TEST_NAMES:
        return file_operands(joined, line[1:]), None
    consumer = lookup(joined, session, registry)
    if joined in session.functions or not (
        word_policy(consumer) is WordPolicy.MOUNT
        or consumer is Consumer.EXTERNAL
        or joined in INTERPRETER_NAMES
    ):
        return None, None
    # A wrapper's words are the program's it runs.
    runs = runs_as(joined, registry)
    spec = spec_for_command(runs, registry, session.cwd, line[consumed:])
    if not spec:
        return None, None
    extra: list[ValueType | None] = ["str"] * (consumed - 1)
    word_kinds = extra + spec_word_kinds(
        spec, line[consumed:], runs, env_snapshot(session)
    )
    bases = spec_word_bases(
        spec, line[consumed:], session.cwd, runs, env_snapshot(session)
    )
    head: list[str | None] = [None] * (consumed - 1)
    word_bases = None if bases is None else head + bases
    return word_kinds, word_bases


def classified_words(
    name: str, args: list[str], session: SessionState, registry: MountRegistry
) -> list[str | PathSpec]:
    """One command's literal words, classified the way the runtime would
    classify them, so the gate and the run name the same paths.

    Args:
        name (str): the head word.
        args (list[str]): the words after it.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the specs.
    """
    line = [name, *args]
    word_kinds, word_bases = _word_hints(line, session, registry)
    return classify_parts(
        line,
        registry,
        session.cwd,
        word_kinds=word_kinds,
        word_bases=word_bases,
    )


def redirect_paths(
    words: Sequence[Word], registry: MountRegistry, cwd: str
) -> tuple[PathSpec, ...]:
    """The paths a statement's redirect targets name.

    Shared by admission and by the dry run, because a rule reads a
    redirect the same way in both: a target only the runtime can expand
    names no path here, and one that is not path-shaped is not a file.

    Args:
        words (Sequence[Word]): the redirect targets as the gate reads
            them.
        registry (MountRegistry): registry the paths are classified
            against.
        cwd (str): session working directory.
    """
    targets = [
        classify_bare_path(w.value, registry, cwd)
        for w in words
        if w.text is not None
    ]
    return tuple(p for p in targets if isinstance(p, PathSpec))


def statement_redirects_raw(node: Any) -> list[Redirect]:
    """Find redirects bound to this command along the last-command chain.

    Args:
        node (Any): the command's tree-sitter node.
    """
    owner = node
    parent = owner.parent
    while parent is not None and parent.type in REDIRECT_CHAIN:
        if (
            not parent.named_children
            or parent.named_children[-1].start_byte != owner.start_byte
        ):
            return []
        owner = parent
        parent = owner.parent
    if (
        parent is None
        or parent.type != NT.REDIRECTED_STATEMENT
        or not parent.named_children
        or parent.named_children[0].start_byte != owner.start_byte
    ):
        return []
    _, redirects = get_redirects(parent)
    return redirects


def statement_stdin(node: Any) -> bytes | None:
    """Mark redirected input without opening or expanding its source.

    Args:
        node (Any): the command's tree-sitter node.
    """
    return (
        b"" if any(r.fd == 0 for r in statement_redirects_raw(node)) else None
    )


def statement_redirects(node: Any, home: str | None) -> tuple[Word, ...]:
    """The redirect targets of the statement holding a command, as the
    gate reads its words: the raw text and the literal it names, None
    when only the runtime can expand it (refused wherever a rule reads
    the command's arguments, like any other word). Heredoc and
    herestring bodies are content, not paths, and a numeric target is
    an fd duplication; neither names a file.

    A redirect binds to one command, and which one is a question about
    the tree rather than the statement: ``a && b > f`` and ``a | b > f``
    both parse as a redirected_statement wrapping the whole list, so
    reading only its first child answered ``a`` and left ``b``, the
    command bash actually opens the file for, with no target at all.
    The walk climbs the last-command chain instead, which is bash's own
    rule for a list, a pipeline and a ``!``. A compound (``{ }``, a loop, a
    subshell) redirects every command inside it, which is not a chain,
    so none is claimed here and the dispatcher judges the write.

    Args:
        node (Any): the command's tree-sitter node.
        home (str | None): the home directory a leading ``~`` names.
    """
    return tuple(
        Word(str(r.target), literal_word(r.target_node, home))
        for r in statement_redirects_raw(node)
        if r.kind
        not in (
            RedirectKind.HEREDOC,
            RedirectKind.HERESTRING,
            RedirectKind.AMBIGUOUS,
        )
        and not isinstance(r.target, int)
        and r.target_node is not None
    )

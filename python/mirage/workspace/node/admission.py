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
import errno
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from mirage.commands.spec.types import ValueType
from mirage.context.session_context import session_path_allowed
from mirage.io.types import ByteSource
from mirage.policy import (Abandoned, AdmissionRules, Ask, Claimant,
                           CommandContext, CommandRule, Deny, HandOff, Pending,
                           PolicyDenied, Scope, ask_rule, refusal_of,
                           render_deny, render_pending)
from mirage.policy.match import (Outcome, has_rules, io_refusal, reads_args,
                                 scopes_paths)
from mirage.runtime.routing import command_nodes
from mirage.shell import parse
from mirage.shell.helpers import (get_parts, get_redirects, get_text,
                                  literal_word, split_env_prefix)
from mirage.shell.types import NodeType as NT
from mirage.shell.types import RedirectKind
from mirage.types import PathSpec, Refusal
from mirage.utils.hidden import is_glob
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.builtins.links.links import follow_paths
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.command.routing import (CWD_DEFAULT_RAW,
                                                       default_cwd_operand,
                                                       path_flag_scopes,
                                                       positional_scopes,
                                                       program_tokens)
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.expand.spec_hints import (spec_for_command,
                                                spec_word_bases,
                                                spec_word_kinds)
from mirage.workspace.lookup import (SHELL_NAMES, SLASH_KEEPS_LAST, WordPolicy,
                                     follows_last_component, is_tool, listed,
                                     lookup, reads_subtrees, walks_mounts,
                                     word_policy)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.node.occurrence import (Frame, argv_frame, line_frame,
                                              occurrence_in, root_frame,
                                              whole_occurrence)
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir

# The nodes a redirected statement may wrap whose last command is the
# one the redirect binds to.
REDIRECT_CHAIN = frozenset({NT.LIST, NT.PIPELINE})


@dataclass(frozen=True, slots=True)
class Refused:
    """What the command plane prints when a line does not get to run.

    Args:
        stderr (bytes): the message, newline-terminated.
        exit_code (int): 127 for a word the session cannot see, 126 for
            a whole-command refusal or an unanswered ask, the operand
            code (1, tar 2) for an operand-scoped refusal.
        refusal (Refusal | None): the record the result carries
            beside stderr; None on the 127 row, which must not say
            the word names anything.
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
    precedence the gate applied to the line, and a refusal is the op
    door's ``PolicyDenied`` (EACCES, the reason, the path), which every
    command renders as GNU's ``Permission denied``.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        tokens (tuple[str, ...]): the line's tokens, command name first.
        judged (frozenset[str]): the virtual paths the gate judged.
        granted (tuple[CommandRule, ...]): the ask rules the line runs
            under a grant for: the one the door answered for this
            line, and the session's standing ones.
        scoped (bool): whether a path rule in force reads this
            command's paths (``EntryGate.scoped``).
    """

    rules: AdmissionRules | None
    tokens: tuple[str, ...]
    judged: frozenset[str]
    granted: tuple[CommandRule, ...]
    scoped: bool

    def check(self, virtual: str) -> None:
        """Raise ``PolicyDenied`` when a rule in force refuses this entry
        for the running command.

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        if _norm(virtual) in self.judged:
            return
        reason = io_refusal(self.rules, self.tokens, virtual, self.granted)
        if reason is not None:
            raise PolicyDenied(errno.EACCES, reason, virtual)


def policy_scopes(
        name: str,
        args: list[str],
        operands: Sequence[str | PathSpec],
        namespace: Namespace | None,
        cwd: str,
        implied: PathSpec | None = None,
        redirects: Sequence[PathSpec] = (),
) -> list[PathSpec]:
    """The paths a path-pattern guard reads for a line.

    The operands as typed and the values of path-valued flags, then, for
    a command that follows links, the targets they resolve to: ``cat
    /data/link`` reads ``/data/secret``, so a rule protecting the target
    has to see it, and a command-scoped rule never runs at the op door
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
        namespace (Namespace | None): the link table; None outside a
            workspace.
        cwd (str): session working directory.
        implied (PathSpec | None): the working-directory operand the
            command reads when typed bare, None when it names a path.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
    """
    scopes = [p for p in operands if isinstance(p, PathSpec)]
    scopes.extend(path_flag_scopes(name, args, cwd))
    if "/" in name:
        # A slash-carrying head word is a file the line executes, and it
        # lives in argv[0], not the operands, so a path-pattern guard
        # would never see it without this row.
        scopes.insert(0, _to_scope(resolve_path(name, cwd)))
    if namespace is not None and namespace.nodes and operands:
        try:
            followed = follow_paths(namespace,
                                    list(operands),
                                    follows_last_component(
                                        name, [name, *args]),
                                    slash_follows=name not in SLASH_KEEPS_LAST)
        except CycleError:
            followed = []
        seen = {p.virtual for p in scopes}
        for item in followed:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)
    if implied is not None and implied.virtual not in {
            p.virtual
            for p in scopes
    }:
        scopes.append(implied)
    if redirects:
        targets: list[str | PathSpec] = list(redirects)
        if namespace is not None and namespace.nodes:
            try:
                followed = follow_paths(namespace, list(redirects), True)
            except CycleError:
                followed = []
            targets.extend(p for p in followed if isinstance(p, PathSpec))
        seen = {p.virtual for p in scopes}
        for item in targets:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)
    return scopes


def _seen(session: Session, specs: list[PathSpec]) -> tuple[PathSpec, ...]:
    """The paths of a line the session can see.

    A hidden path is nonexistent for the session, so no policy may
    learn of it either: a rule scoped to it must not fire (the reason
    would say the path is there), an ask must not be raised for it (a
    request would name it to the host), and the line runs on to the
    door, which answers ENOENT like any other absent path.

    Args:
        session (Session): the session running the line.
        specs (list[PathSpec]): the paths as the gate collected them.
    """
    return tuple(p for p in specs if session_path_allowed(session, p.virtual))


async def gate(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    stdin: ByteSource | None = None,
    redirects: Sequence[PathSpec] = (),
    defined_fn: bool = False,
) -> Refused | tuple[CommandContext, Deny | Ask | None]:
    """Everything the gate decides about one command before anything is
    spent on it: visibility, the classified context, and the policy
    chain's answer.

    Split out of :func:`admit` so a dry run can have the answer without
    the consequences. Nothing here records a request, consumes a grant
    or reaches the host, which is what makes it safe for
    ``explain``; :func:`admit` adds exactly those and renders.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies and the
            CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        stdin (ByteSource | None): the line's stdin, which decides
            whether a bare ``rg`` reads the working directory.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
        defined_fn (bool): the caller vouches the head word is a shell
            function defined by run time. The provision walk vouches
            for a function its own script defines: the run stores that
            definition in the session before the call, a dry run keeps
            it in plan state, where neither ``command_visible`` nor
            ``is_tool`` can see it. The word is then judged exactly as
            the run would judge it — exempt from the allow lists unless
            a builtin shadows it (``SHELL_NAMES``), and ``ctx.tool``
            False accordingly.

    Returns:
        A Refused when the session cannot see the head word, else the
        context and whatever the policy chain answered.
    """
    tool = (name in SHELL_NAMES) if defined_fn else is_tool(name, session)
    if tool and not listed(name, session):
        return Refused(f"{name}: command not found\n".encode(), 127)
    tokens, program = program_tokens(registry, name, args, session.cwd)
    implied = (default_cwd_operand([name, *operands], name, registry,
                                   session.cwd, stdin)
               if name in CWD_DEFAULT_RAW else None)
    ctx = CommandContext(command=name,
                         paths=_seen(
                             session,
                             policy_scopes(name, args, operands, namespace,
                                           session.cwd, implied, redirects)),
                         operands=_seen(
                             session,
                             positional_scopes(name, args, session.cwd,
                                               list(operands))),
                         argv=tuple(args),
                         cwd=session.cwd,
                         registry=registry,
                         session_id=session.session_id,
                         agent_id=agent_id,
                         tokens=tokens,
                         program=program,
                         tool=tool,
                         walks=walks_mounts(name, [name, *args]))
    return ctx, await registry.policies.pre_command(ctx)


async def admit(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    stdin: ByteSource | None = None,
    redirects: Sequence[PathSpec] = (),
    cancel: asyncio.Event | None = None,
    claimant: Claimant | None = None,
) -> Refused | Admitted:
    """The command plane's admission of one command: visibility, then
    the policy chain, then the decision ledger.

    The one gate every command class passes through, in the tree
    (``_run_argv``, once the words are expanded) and for a line a
    runtime takes whole (``admit_line``, per parsed command). A word
    the session's allow lists do not install is bash's "command not
    found" before any admission hook, so an unlisted tool never leaks
    a deny reason; a path the session cannot see is dropped before any
    hook, so a rule never names it and the door answers ENOENT; a Deny
    renders in the outcome table's voice; an Ask is answered by the
    door from the session's grants or the host. A command that gets
    through comes back as its ``Admitted`` gate, which its own I/O
    consults for the entries the gate did not see.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to, for an
            ledger record.
        stdin (ByteSource | None): the line's stdin, which decides
            whether a bare ``rg`` reads the working directory.
        redirects (Sequence[PathSpec]): the statement's expanded
            redirect targets, empty when it has none.
        cancel (asyncio.Event | None): the run's kill channel, carried
            only so a question put to a host cannot outlive the run
            that raised it. Nothing else here waits on anything outside
            mirage.
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
    """
    gated = await gate(name, args, operands, session, registry, namespace,
                       agent_id, stdin, redirects)
    if isinstance(gated, Refused):
        return gated
    ctx, asked = gated
    # An Ask is the chain's answer only after every Deny had its say;
    # the ledger answers it from the session's records or the host, so
    # an answer never re-opens a deny.
    action: Deny | Pending | Abandoned | None = (
        await registry.decisions.resolve(ctx, asked, cancel, claimant)
        if isinstance(asked, Ask) else asked)
    # The ledger stopped waiting on a host because this run was killed
    # while it was deciding. That is the kill landing late, not a ruling,
    # so it joins every other abandoned wait rather than being rendered
    # as a refusal the document never made.
    if isinstance(action, Abandoned):
        raise MirageAbortError()
    if action is None:
        granted = [
            r.rule for r in session.decisions
            if r.scope is Scope.SESSION and r.outcome is Outcome.ALLOW
        ]
        if isinstance(asked, Ask):
            granted.insert(0, ask_rule(ctx, asked))
        rules = session.commands
        return Admitted(rules=rules,
                        tokens=ctx.tokens,
                        judged=frozenset(_norm(p.virtual) for p in ctx.paths),
                        granted=tuple(granted),
                        scoped=scopes_paths(rules, name))
    err, code = (render_pending(name, action)
                 if isinstance(action, Pending) else render_deny(name, action))
    return Refused(err, code, refusal_of(action))


def is_pending_refusal(refusal: Refusal | None) -> bool:
    """Whether a record is a question the host has not answered yet,
    which holds the line for its retry rather than ending it.

    Args:
        refusal (Refusal | None): the record a result carries.
    """
    return refusal is not None and refusal.kind == "pending"


def is_pending(refused: Refused) -> bool:
    """Whether a refusal is a question the host has not answered yet.

    Args:
        refused (Refused): what the gate refused with.
    """
    return is_pending_refusal(refused.refusal)


def _refuse(name: str, reason: str) -> Refused:
    deny = Deny(reason)
    err, code = render_deny(name, deny)
    return Refused(err, code, refusal_of(deny))


def _unreadable(raw: str) -> str:
    return f"cannot read {raw} before the runtime expands it"


def _word_hints(
    line: list[str], session: Session, registry: MountRegistry
) -> tuple[list[ValueType | None] | None, list[str | None] | None]:
    """The spec's per-position classification hints for a literal line,
    the way ``expand_argv`` computes them for an expanded one.

    Without them a bare filename operand stays text (``cat secret``
    from ``/data`` yields no ``/data/secret`` scope) and a chdir option
    (tar's ``-C``) resolves later words against the wrong base, so a
    rule and the run would disagree about the paths the line names.

    Args:
        line (list[str]): the literal words, name first.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the specs.
    """
    consumed = registry.match_command_prefix(line)
    joined = " ".join(line[:consumed])
    if (joined in session.functions or word_policy(
            lookup(joined, session, registry)) is not WordPolicy.MOUNT):
        return None, None
    spec = spec_for_command(joined, registry, session.cwd)
    if not spec:
        return None, None
    extra: list[ValueType | None] = ["str"] * (consumed - 1)
    word_kinds = extra + spec_word_kinds(spec, line[consumed:], joined)
    bases = spec_word_bases(spec, line[consumed:], session.cwd)
    head: list[str | None] = [None] * (consumed - 1)
    word_bases = None if bases is None else head + bases
    return word_kinds, word_bases


def classified_words(name: str, args: list[str], session: Session,
                     registry: MountRegistry) -> list[str | PathSpec]:
    """One command's literal words, classified the way the runtime would
    classify them, so the gate and the run name the same paths.

    Args:
        name (str): the head word.
        args (list[str]): the words after it.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the specs.
    """
    line = [name, *args]
    word_kinds, word_bases = _word_hints(line, session, registry)
    return classify_parts(line,
                          registry,
                          session.cwd,
                          word_kinds=word_kinds,
                          word_bases=word_bases)


def redirect_paths(words: Sequence[Word], registry: MountRegistry,
                   cwd: str) -> tuple[PathSpec, ...]:
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
        classify_bare_path(w.value, registry, cwd) for w in words
        if w.text is not None
    ]
    return tuple(p for p in targets if isinstance(p, PathSpec))


async def _admit_words(
    words: list[Word],
    open_: bool,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    rules: AdmissionRules | None,
    redirect_words: tuple[Word, ...] = (),
    cancel: asyncio.Event | None = None,
    claimant: Claimant | None = None,
) -> Refused | None:
    """Admit one command of a whole line on the words the gate read,
    then whatever lines the command runs in turn.

    Args:
        words (list[Word]): the command's words, name first.
        open_ (bool): whether the runtime appends operands the gate
            cannot read (``xargs``, ``find -exec``).
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        rules (AdmissionRules | None): the session's admission rules.
        redirect_words (tuple[Word, ...]): the statement's redirect
            targets, as the gate reads them.
        cancel (asyncio.Event | None): the run's kill channel.
        claimant (Claimant | None): the command and its line, as
            ``admit`` takes it; the lines it runs stand under it.
    """
    head = words[0]
    if head.text is None and has_rules(rules):
        return _refuse(head.raw, _unreadable(head.raw))
    name = head.value
    args = [w.value for w in words[1:]]
    line = [name, *args]
    classified = classified_words(name, args, session, registry)
    redirects = redirect_paths(redirect_words, registry, session.cwd)
    action = await admit(name,
                         args,
                         classified[1:],
                         session,
                         registry,
                         namespace,
                         agent_id,
                         redirects=redirects,
                         cancel=cancel,
                         claimant=claimant)
    if isinstance(action, Refused):
        return action
    if action.scoped:
        # The runtime walks and globs on its own, where no entry gate
        # follows an I/O below the judged words, so a command a path or
        # mount rule reads must not reach it with either in hand.
        if reads_subtrees(name, line):
            return _refuse(name, "walks a tree the gate cannot follow")
        if any(
                is_glob(p.raw_path or p.virtual)
                for p in (*classified[1:], *redirects)
                if isinstance(p, PathSpec)):
            return _refuse(name, "expands a pattern only the runtime can read")
    unread = next(
        (w.raw for w in (*words[1:], *redirect_words) if w.text is None), None)
    if (unread is not None or open_) and reads_args(rules, name):
        return _refuse(
            name,
            _unreadable(unread)
            if unread is not None else "runs on operands the gate cannot read")
    for inner in inner_lines(name, words[1:]):
        if not inner.readable:
            if has_rules(rules):
                return _refuse(name, "runs lines the gate cannot read")
            continue
        if inner.line is not None:
            frame = (line_frame(inner.line, claimant.occurrence)
                     if claimant is not None else None)
            refusal = await admit_line(parse(inner.line), session, registry,
                                       namespace, agent_id, cancel,
                                       claimant.line if claimant else None,
                                       frame, inner.open)
        else:
            argv = list(inner.argv)
            within = (Claimant(
                claimant.line,
                whole_occurrence(
                    argv_frame([w.value for w in argv], claimant.occurrence)))
                      if claimant is not None else None)
            refusal = await _admit_words(argv,
                                         inner.open,
                                         session,
                                         registry,
                                         namespace,
                                         agent_id,
                                         rules,
                                         cancel=cancel,
                                         claimant=within)
        if refusal is not None:
            return refusal
    return None


async def admit_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    cancel: asyncio.Event | None = None,
    handed: HandOff | None = None,
    frame: Frame | None = None,
    open_: bool = False,
) -> Refused | None:
    """Admit every command of a line a runtime takes whole.

    A whole line is a command like any other, but the runtime does the
    expanding, so the gate reads the line as typed: each command is
    admitted on its literal words (quotes removed, escapes resolved, a
    path-shaped word a path, an installed CLI's verb path walked), and
    the first refusal is the line's. A word only the runtime can expand
    (``$cmd``, ``"$p"``, ``$(...)``, ``{a,b}``) is refused wherever a
    rule in force would have read it: as the command name whenever the
    session has any command rule, as an argument when a rule reads that
    command's arguments (a pattern with a token after the name, a
    path-scoped or mount-scoped rule). The words that run other words
    (``eval``, ``sh -c``, ``xargs``, ``env`` ... see ``inner_lines``)
    have those lines admitted in turn, and a line the gate cannot read
    at all (a sourced file, a script, ``eval "$p"``) is refused under
    any command rule. A statement's redirect targets are read as words
    of its command, so ``cat < /data/secret`` is judged on the file it
    opens. A command a path or mount rule reads is refused outright
    when its I/O would pass the judged words -- a walk (``find``,
    ``grep -r``, ``tar -c``) or a glob only the runtime expands --
    because every line executor acts outside the entry gate (a remote
    sandbox's own disk, a host process), so a walk the gate cannot
    follow does not run; a runtime whose I/O rides the dispatcher could
    relax this by carrying the gate. With no rule in force nothing is
    refused on this account: the words are admitted as typed, which is
    all a coded policy ever saw.

    No gate follows this pass: the runtime runs the line whole, so
    every grant it matches is claimed on the line's hand-off exactly as
    any reader on a line claims, and the executor's sweep spends them
    when the line ends. A line held on a question still waiting keeps
    its earlier answers standing for the retry, exactly as the
    compound-line pass does, where spending them here asked the human
    again for each on every retry.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel.
        handed (HandOff | None): the line's hand-off, None outside a
            line (a bare admission with no run behind it).
        frame (Frame | None): the scope the line is read in, for a line
            a word runs; None reads ``ast`` as the line itself.
        open_ (bool): whether the runtime appends operands the gate
            cannot read to the line (``mapfile -C``'s callback, which
            runs with the index and the record after it), as
            ``_admit_words`` takes it for each of its commands.
    """
    rules = session.commands
    home = home_dir(session)
    if frame is None:
        frame = root_frame(ast, handed.origin if handed is not None else None)
    for node in command_nodes(ast):
        _, parts = split_env_prefix(get_parts(node))
        words = [
            Word(get_text(part), literal_word(part, home)) for part in parts
        ]
        if not words:
            continue
        refusal = await _admit_words(
            words,
            open_,
            session,
            registry,
            namespace,
            agent_id,
            rules,
            redirect_words=statement_redirects(node, home),
            cancel=cancel,
            claimant=Claimant(handed, occurrence_in(node, frame))
            if handed is not None else None)
        if refusal is not None:
            return refusal
    return None


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
    rule for a list and a pipeline. A compound (``{ }``, a loop, a
    subshell) redirects every command inside it, which is not a chain,
    so none is claimed here and the op door judges the write.

    Args:
        node (Any): the command's tree-sitter node.
        home (str | None): the home directory a leading ``~`` names.
    """
    owner = node
    parent = owner.parent
    while parent is not None and parent.type in REDIRECT_CHAIN:
        if not parent.named_children or parent.named_children[-1] != owner:
            return ()
        owner = parent
        parent = owner.parent
    if (parent is None or parent.type != NT.REDIRECTED_STATEMENT
            or not parent.named_children or parent.named_children[0] != owner):
        return ()
    _, redirects = get_redirects(parent)
    return tuple(
        Word(str(r.target), literal_word(r.target_node, home))
        for r in redirects
        if r.kind not in (RedirectKind.HEREDOC, RedirectKind.HERESTRING,
                          RedirectKind.AMBIGUOUS)
        and not isinstance(r.target, int) and r.target_node is not None)

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
from collections.abc import Generator, Iterator, Sequence
from typing import Any

from mirage.policy import (Abandoned, Ask, CommandContext, Deny, Explanation,
                           Pending, render_deny, render_pending)
from mirage.policy.match import Outcome, decide
from mirage.shell import parse
from mirage.shell.helpers import (get_parts, get_text, literal_word,
                                  split_env_prefix)
from mirage.shell.parse import opaque_reads, referenced_names
from mirage.shell.types import NodeType
from mirage.types import PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import (Refusal, admit, classified_words,
                                             gate, redirect_paths,
                                             statement_redirects)
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir

UNREADABLE = "cannot read {raw} before the runtime expands it"

# Nodes that run their commands in a child shell: a ``cd`` inside one
# applies to the rest of that child and is gone when it exits. A
# pipeline is not here because it forks per segment, not once.
FORK_SCOPES = frozenset({
    NodeType.SUBSHELL,
    NodeType.COMMAND_SUBSTITUTION,
    NodeType.PROCESS_SUBSTITUTION,
})


def _unreadable(raw: str) -> Explanation:
    """The explanation of a word only the runtime can expand.

    Args:
        raw (str): the word as typed.
    """
    reason = UNREADABLE.format(raw=raw)
    err, code = render_deny(raw, Deny(reason))
    return Explanation(command=raw,
                       outcome=Outcome.DENY,
                       reason=reason,
                       exit_code=code,
                       stderr=err.decode())


def _from_refusal(name: str, args: tuple[str, ...],
                  refusal: Refusal) -> Explanation:
    """The explanation of a head word the session cannot see.

    Args:
        name (str): the head word.
        args (tuple[str, ...]): the words after it.
        refusal (Refusal): what the gate answered.
    """
    return Explanation(command=name,
                       argv=args,
                       outcome=Outcome.DENY,
                       source="commands.allow",
                       exit_code=refusal.exit_code,
                       stderr=refusal.stderr.decode())


def _explained(ctx: CommandContext, session: Session, registry: MountRegistry,
               asked: Deny | Ask | None) -> Explanation:
    """One command's explanation, rendered from the same table the gate
    renders a refusal with.

    An Ask reads the session's standing grants and stops there
    (``Decisions.held``): a dry run must not spend one, record a
    question or reach the host. An answer that already covers the ask
    leaves the outcome ASK, because that is what the document says,
    with exit 0, because that is what the line would do.

    Args:
        ctx (CommandContext): the classified command.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the decision ledger.
        asked (Deny | Ask | None): what the policy chain answered.
    """
    decision = decide(ctx, session.commands)
    base = Explanation(command=ctx.command,
                       argv=ctx.argv,
                       outcome=decision.outcome,
                       rule=decision.rule,
                       reason=decision.rule.reason if decision.rule else "",
                       source=decision.source,
                       matched_path=decision.matched_path,
                       paths=tuple(p.virtual for p in ctx.paths))
    action: Deny | Pending | None = (registry.decisions.held(ctx, asked)
                                     if isinstance(asked, Ask) else asked)
    if action is None:
        return base
    err, code = (render_pending(ctx.command, action) if isinstance(
        action, Pending) else render_deny(ctx.command, action))
    reason = action.reason if base.reason == "" else base.reason
    return Explanation(command=base.command,
                       argv=base.argv,
                       outcome=base.outcome,
                       rule=base.rule,
                       reason=reason,
                       source=base.source,
                       matched_path=base.matched_path,
                       paths=base.paths,
                       exit_code=code,
                       stderr=err.decode())


async def explain_words(
        words: list[Word],
        session: Session,
        registry: MountRegistry,
        namespace: Namespace | None,
        agent_id: str = "",
        redirect_words: tuple[Word, ...] = (),
) -> list[Explanation]:
    """Explain one command and whatever lines it runs in turn.

    The redirect targets are read as words of the command, exactly as
    admission reads them: the shell opens them on its own fds, outside
    the window the command's own gate covers, so a rule about
    ``/protected`` sees ``echo x > /protected`` only if they are passed
    here. Omitting them made the dry run answer ALLOW for a line the
    run then refused.

    Args:
        words (list[Word]): the command's words, name first.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        redirect_words (tuple[Word, ...]): the statement's redirect
            targets, empty for a command that has none and for the
            inner lines a command runs, which admission reads the same
            way.
    """
    head = words[0]
    if head.text is None:
        return [_unreadable(head.raw)]
    name = head.value
    args = [w.value for w in words[1:]]
    classified = classified_words(name, args, session, registry)
    gated = await gate(name,
                       args,
                       classified[1:],
                       session,
                       registry,
                       namespace,
                       agent_id,
                       redirects=redirect_paths(redirect_words, registry,
                                                session.cwd))
    if isinstance(gated, Refusal):
        return [_from_refusal(name, tuple(args), gated)]
    ctx, asked = gated
    out = [_explained(ctx, session, registry, asked)]
    for inner in inner_lines(name, words[1:]):
        if not inner.readable:
            continue
        if inner.line is not None:
            out.extend(await explain_line(parse(inner.line), session, registry,
                                          namespace, agent_id))
        else:
            out.extend(await explain_words(list(inner.argv), session, registry,
                                           namespace, agent_id))
    return out


def _is_verdict(expl: Explanation) -> bool:
    """Whether an explanation refuses the line's intent, rather than
    just failing one command.

    A rule that named itself is a verdict. So is a refusal the document
    said nothing about: a coded policy answers on its own account, and
    with no permissions document there is no rule for it to point at,
    so reading "no rule" as "no verdict" made every coded policy invisible
    to the pass. What stays out is the rule-less DENY: a head word the
    session cannot see, a line no allow entry covers, and a word only
    the runtime can expand, each of which the docstring above explains
    is answered where it happens rather than against the whole line.

    Args:
        expl (Explanation): one command's explanation.
    """
    if expl.exit_code == 0:
        return False
    return expl.rule is not None or expl.outcome is Outcome.ALLOW


WalkItem = tuple[list[Word], tuple[Word, ...], Session]

# A walk yields each command and returns the session its scope ends in,
# which is how a `cd` reaches the commands after it without escaping the
# child shell it ran in.
Walk = Generator[WalkItem, None, Session]


def _words_of(node: Any, home: str | None) -> list[Word]:
    """One command node's words, name first, the env prefix dropped.

    Args:
        node (Any): the command's tree-sitter node.
        home (str | None): the home directory a leading ``~`` names.
    """
    _, parts = split_env_prefix(get_parts(node))
    return [Word(get_text(part), literal_word(part, home)) for part in parts]


def _walk_node(node: Any, session: Session, home: str | None) -> Walk:
    """Every command under one node, in source order, each with the
    session it is judged in; returns the session the node leaves behind.

    A ``cd`` reaches the commands after it, and how far is the whole
    question. Pinned against bash: ``( )``, ``$( )`` and ``<( )`` run
    their contents in a child shell, so a ``cd`` inside one applies to
    the rest of that child and is gone when it exits; a pipeline forks
    once per segment, so a ``cd`` in one segment reaches neither the
    next segment nor the line; ``&`` backgrounds into a fork; and a
    brace group or an ``if`` body does not fork at all, so its ``cd``
    does escape. Reading a subshell as "no ``cd`` applies" rather than
    "no ``cd`` escapes" judged ``(cd d && tar -c ..)`` at the wrong
    directory, which made ``..`` read as a mount root.

    The session is returned rather than carried down because that is
    what "escapes" means, and because ``&`` is not a wrapper node: it is
    a token following its command, visible only to whoever holds the
    sibling list.

    Args:
        node (Any): the tree-sitter node to walk.
        session (Session): the session this node begins in.
        home (str | None): the home directory a leading ``~`` names.
    """
    if node.type == NodeType.COMMAND:
        walked = session
        words = _words_of(node, home)
        if words:
            yield words, statement_redirects(node, home), session
            walked = _after_cd(words, session)
        for child in node.children:
            # A substitution among the words runs in its own shell.
            yield from _walk_node(child, session, home)
        return walked
    if node.type in FORK_SCOPES:
        yield from _walk_children(node, session, home)
        return session
    if node.type == NodeType.PIPELINE:
        for child in node.children:
            yield from _walk_node(child, session, home)
        return session
    return (yield from _walk_children(node, session, home))


def _walk_children(node: Any, session: Session, home: str | None) -> Walk:
    """One scope's children in order, threading the cwd between them;
    returns the session the scope ends in.

    Args:
        node (Any): the tree-sitter node whose children form the scope.
        session (Session): the session the scope begins in.
        home (str | None): the home directory a leading ``~`` names.
    """
    walked = session
    children = node.children
    for index, child in enumerate(children):
        after = children[index + 1] if index + 1 < len(children) else None
        ended = yield from _walk_node(child, walked, home)
        if after is not None and after.type == "&":
            continue
        walked = ended
    return walked


def _after_cd(words: list[Word], session: Session) -> Session:
    """The session the next command of a line is judged in, which
    differs from this one only when this command was a literal ``cd``.

    ``cd /repo && git commit`` is judged before the line runs, so
    without this the rule about ``/repo`` reads the cwd the session
    happened to be in and answers about the wrong directory. A ``cd``
    whose argument the gate cannot read (``cd "$d"``) leaves the cwd
    where it was, and the per-command gate judges that command in the
    real one.

    Args:
        words (list[Word]): the command's words, name first.
        session (Session): the session the command was judged in.
    """
    if len(words) != 2 or words[0].value != "cd" or words[1].text is None:
        return session
    target = words[1].value
    if target.startswith("-"):
        return session
    return session.fork(cwd=resolve_path(target, session.cwd))


def _walked_line(ast: Any, session: Session) -> Iterator[WalkItem]:
    """Every command of a line with its redirect targets and the session
    it is judged in.

    The cwd is the one fact that moves as a line runs, and both readers
    of a line need the same answer about it: a host asking what a line
    would do and the pass deciding whether to let it run cannot differ,
    or ``explain`` would report an allow the run then refuses. The
    redirects ride along for the same reason: they are read here so both
    readers judge the file the shell opens, not just the operands.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
    """
    yield from _walk_node(ast, session, home_dir(session))


async def prejudge_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    cancel: asyncio.Event | None = None,
) -> Refusal | None:
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

    - A head word the session cannot see is a routing miss, not a
      verdict. It stays bash: the stage fails with "command not found"
      and the rest of the line does what bash does, so a typo cannot
      cost an agent the work the line already did.
    - A word only the runtime can expand is judged where it is
      expanded, by the per-command gate, which sees the real path.

    That second one is the limit of the hold, and it is worth stating
    plainly: this pass reads the *text* of a line, while the gate reads
    its *values*, so a path the runtime computes (``cat $S``, ``$( )``,
    a ``cd`` whose argument is a variable) is invisible here. The rule
    is still enforced, by the gate, but the earlier commands have run
    by then. For a deny that costs allowed side effects and nothing
    more, since the commands that ran were on the allow list. For an
    ask it costs the replay: the question is recorded after part of the
    line already happened, so approving it re-runs a line whose first
    half is done. Closing that would mean asking whenever a word cannot
    be read, which over-asks with no way out for a deny, so a
    deployment that needs the hold for a computed path states it in a
    policy script rather than here.

    The pass is read-only (:func:`explain_line`), so it spends no grant
    and records no request; a command it refuses on is then put through
    the real gate, which is where an ask is recorded, exactly once, for
    a line that will not run.

    Every command is judged whether or not the session carries a
    document. A coded policy refuses on its own account, and one is
    always registered (``MountRootPolicy``), so returning early on a
    session with no rules held the line for a document and let a policy
    keep the half-line behavior the pass exists to remove.

    A line with one command to judge is left to the per-command gate,
    which is not an optimization but the more faithful answer: there is
    no earlier command whose side effects a hold could save, and the
    gate refuses from inside the shell, so the line's own redirections
    still apply. This pass answers above them, so refusing
    ``rm -rf /mnt 2>&1`` here wrote the refusal to stderr where bash
    puts it on stdout.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel. This
            pass puts real questions to a host, so it carries it
            exactly as the per-command gate does; without it a compound
            line asked here waited on an answer its own timeout could
            no longer cut short.

    Returns:
        The line's refusal, or None to run it.
    """
    judged = []
    for words, redirects, walked in _walked_line(ast, session):
        if words[0].text is None:
            continue
        judged.append((redirects, walked, await
                       explain_words(words, walked, registry, namespace,
                                     agent_id, redirects)))
    if sum(len(explained) for _, _, explained in judged) < 2:
        return None
    for redirects, walked, explained in judged:
        targets = redirect_paths(redirects, registry, walked.cwd)
        for index, expl in enumerate(explained):
            if not _is_verdict(expl):
                continue
            args = list(expl.argv)
            classified = classified_words(expl.command, args, walked, registry)
            answered = await admit(
                expl.command,
                args,
                classified[1:],
                walked,
                registry,
                namespace,
                agent_id,
                # explain_words lists the statement's own command first
                # and the lines it runs after it, so only the first
                # explanation is the command the redirects belong to.
                redirects=targets if index == 0 else (),
                cancel=cancel)
            if isinstance(answered, Refusal):
                return answered
            # The host answered this one inline. The rest of the line
            # has not been judged yet, so the scan goes on: stopping
            # here let a later command's deny run behind an approval.
    return None


async def _verdict_refuses(
    expl: Explanation,
    redirects: Sequence[PathSpec],
    walked: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    cancel: asyncio.Event | None,
) -> bool:
    """Whether a verdict's answer refuses the command, putting an
    unanswered ask's question to the host.

    The chain is asked again rather than the explanation re-read,
    because ``Explanation.outcome`` is the document's answer: a coded
    policy's ask arrives with whatever the document said, so only the
    chain's own answer separates a deny from an ask. A deny refuses
    outright. An ask's settled record is read without being spent
    (``Decisions.held``), so the gate that then runs the line consumes
    the same answer, in its own voice and behind the line's
    redirections; an unanswered rule is raised through the same ledger
    the gate reads, so the answer lands exactly once and the gate does
    not ask again.

    Args:
        expl (Explanation): the verdict's explanation.
        redirects (Sequence[PathSpec]): the statement's redirect
            targets, empty for a command that has none.
        walked (Session): the session the command is judged in.
        registry (MountRegistry): registry holding the policies and the
            decision ledger.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    args = list(expl.argv)
    classified = classified_words(expl.command, args, walked, registry)
    gated = await gate(expl.command,
                       args,
                       classified[1:],
                       walked,
                       registry,
                       namespace,
                       agent_id,
                       redirects=redirects)
    if isinstance(gated, Refusal):
        return True
    ctx, asked = gated
    if not isinstance(asked, Ask):
        return isinstance(asked, Deny)
    standing = registry.decisions.held(ctx, asked)
    if standing is None:
        return False
    if isinstance(standing, Deny):
        return True
    action = await registry.decisions.resolve(ctx, asked, cancel)
    if isinstance(action, Abandoned):
        raise MirageAbortError()
    return action is not None


def _defines_function(node: Any) -> bool:
    """Whether the node defines a function anywhere in its tree.

    A definition's body is walked by ``_walked_line`` like any other
    scope, but it runs at invocation, not here, so a command inside one
    must not be read as the node's own: judging it would refuse a line
    that only stores text, and the read walks already charge nothing
    for it.

    Args:
        node (Any): the tree-sitter node to scan.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == "function_definition":
            return True
        stack.extend(current.named_children)
    return False


def _sole_literal_command(node: Any, session: Session) -> WalkItem | None:
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
        session (Session): the session the line runs in.
    """
    items = list(_walked_line(node, session))
    if len(items) != 1:
        return None
    words, redirects, _ = items[0]
    if any(word.text is None for word in (*words, *redirects)):
        return None
    if _defines_function(node):
        return None
    if referenced_names(node) or opaque_reads(node):
        return None
    return items[0]


async def _command_refused(
    item: WalkItem,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    cancel: asyncio.Event | None,
) -> bool:
    """Whether one walked command is refused on its text, resolving an
    unanswered ask through the ledger the gate reads.

    Args:
        item (WalkItem): the command's words, redirect targets and the
            session it is judged in.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    words, redirects, walked = item
    explained = await explain_words(words, walked, registry, namespace,
                                    agent_id, redirects)
    targets = redirect_paths(redirects, registry, walked.cwd)
    for index, expl in enumerate(explained):
        if not _is_verdict(expl):
            continue
        # explain_words lists the statement's own command first and
        # the lines it runs after it, so only the first explanation
        # is the command the redirects belong to.
        if await _verdict_refuses(expl, targets if index == 0 else (), walked,
                                  registry, namespace, agent_id, cancel):
            return True
    return False


async def unrefused_nodes(
    nodes: Sequence[Any],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
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
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel, carried
            because an unanswered ask is put to the host here.
    """
    out: list[Any] = []
    for position, node in enumerate(nodes):
        item = _sole_literal_command(node, session)
        if item is None:
            out.append(node)
            continue
        if await _command_refused(item, registry, namespace, agent_id, cancel):
            if position == 0:
                return []
            continue
        out.append(node)
    return out


async def explain_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
) -> list[Explanation]:
    """What every command of a line would do, in the order the gate
    reads them, without running any of it.

    The dry run of the gate: the same visibility check, the same
    context, the same policy chain and the same outcome table, so a
    host reading this and an agent typing the line cannot be told
    different things. What it deliberately does not do is the half of
    admission that costs something, since a line nobody typed must not
    consume a grant or put a question to a host.

    The words are read literally, as ``admit_line`` reads them, so
    nothing is expanded and no ``$( )`` runs.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
    """
    out: list[Explanation] = []
    for words, redirects, walked in _walked_line(ast, session):
        out.extend(await explain_words(words, walked, registry, namespace,
                                       agent_id, redirects))
    return out

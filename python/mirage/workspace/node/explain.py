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
from dataclasses import dataclass
from typing import Any

from mirage.policy import (Abandoned, Ask, Claimant, CommandContext, Deny,
                           Explanation, HandOff, Occurrence, Pending,
                           refusal_of, render_deny, render_pending)
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
from mirage.workspace.node.admission import (Refused, admit, classified_words,
                                             gate, is_pending_refusal,
                                             redirect_paths,
                                             statement_redirects)
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.node.occurrence import (Frame, argv_frame, body_frame,
                                              line_frame, occurrence_in,
                                              root_frame, segment_frames,
                                              whole_occurrence)
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
    deny = Deny(reason)
    err, code = render_deny(raw, deny)
    return Explanation(command=raw,
                       outcome=Outcome.DENY,
                       reason=reason,
                       exit_code=code,
                       stderr=err.decode(),
                       refusal=refusal_of(deny))


def _from_refusal(name: str, args: tuple[str, ...],
                  refusal: Refused) -> Explanation:
    """The explanation of a head word the session cannot see.

    Args:
        name (str): the head word.
        args (tuple[str, ...]): the words after it.
        refusal (Refused): what the gate answered.
    """
    return Explanation(command=name,
                       argv=args,
                       outcome=Outcome.DENY,
                       source="commands.allow",
                       exit_code=refusal.exit_code,
                       stderr=refusal.stderr.decode(),
                       refusal=refusal.refusal)


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
                       stderr=err.decode(),
                       refusal=refusal_of(action))


@dataclass(frozen=True, slots=True)
class Judged:
    """One command's explanation and where the command stands.

    The occurrence is what the pass hands the ledger beside the
    explanation: a grant claimed for the command is bound to it, so
    the gate that runs the same occurrence finds it and no other
    reader does.

    Args:
        explanation (Explanation): what the command would do.
        occurrence (Occurrence): the command's place on the line.
        stated (bool): whether the gate will read the command in the
            words the pass read: every word literal, and no operand
            the runtime appends. The gate reads ``cat $F`` as the path
            ``$F`` expands to and ``xargs cat`` as ``cat`` plus the
            items on its stdin, so a question the pass asked about
            either spelling would be answered for words that never
            run, and the gate would ask again about the words that do.
            Such a command is judged here for a deny, which speaks on
            the name alone, and asked about at the gate.
    """

    explanation: Explanation
    occurrence: Occurrence
    stated: bool


async def _judge_words(
    words: list[Word],
    occurrence: Occurrence,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    redirect_words: tuple[Word, ...] = (),
    stated: bool = True,
) -> list[Judged]:
    """Explain one command and whatever lines it runs in turn, each
    with its occurrence.

    The redirect targets are read as words of the command, exactly as
    admission reads them: the shell opens them on its own fds, outside
    the window the command's own gate covers, so a rule about
    ``/protected`` sees ``echo x > /protected`` only if they are passed
    here. Omitting them made the dry run answer ALLOW for a line the
    run then refused. A line the command runs (``eval``, ``sh -c``) is
    parsed on its own and read under the command's occurrence, exactly
    as the nested evaluation will stand when it runs; words a command
    runs (``command``, ``env``, ``timeout``, ``xargs``) are read as the
    one line the builtin hands the evaluator, spelled as it spells it.

    Args:
        words (list[Word]): the command's words, name first.
        occurrence (Occurrence): the command's place on the line.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        redirect_words (tuple[Word, ...]): the statement's redirect
            targets, empty for a command that has none and for the
            inner lines a command runs, which admission reads the same
            way.
        stated (bool): whether the words reach here as the gate will
            read them; False under a command the runtime completes,
            since a line built from its words (``eval``) or run on its
            operands (``xargs``) is completed with them.
    """
    head = words[0]
    if head.text is None:
        return [Judged(_unreadable(head.raw), occurrence, False)]
    stated = stated and all(w.text is not None for w in words)
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
    if isinstance(gated, Refused):
        return [
            Judged(_from_refusal(name, tuple(args), gated), occurrence, stated)
        ]
    ctx, asked = gated
    out = [
        Judged(_explained(ctx, session, registry, asked), occurrence, stated)
    ]
    for inner in inner_lines(name, words[1:]):
        if not inner.readable:
            continue
        if inner.line is not None:
            out.extend(await _judge_line(parse(inner.line), session, registry,
                                         namespace, agent_id,
                                         line_frame(inner.line, occurrence),
                                         stated and not inner.open))
        else:
            argv = list(inner.argv)
            within = whole_occurrence(
                argv_frame([w.value for w in argv], occurrence))
            out.extend(await _judge_words(argv,
                                          within,
                                          session,
                                          registry,
                                          namespace,
                                          agent_id,
                                          stated=stated and not inner.open))
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


def _refuses(expl: Explanation) -> bool:
    """Whether an explanation refuses the command outright, rather than
    reporting a line that would run or a question the host has not
    answered.

    Args:
        expl (Explanation): one command's explanation.
    """
    return expl.exit_code != 0 and not is_pending_refusal(expl.refusal)


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
    return one.stated or _refuses(one.explanation)


def _is_judged(expl: Explanation) -> bool:
    """Whether the compound-line pass puts a command through the gate.

    A verdict is, so the line is refused whole. So is a command that
    would run, because "would run" may mean a standing grant answers
    its ask, and only the gate can claim that grant for this line: read
    but not claimed, one nod answered every spelling of the command on
    the line, and a grant given to a line that was then refused stood
    for the next one. What stays out is the rule-less DENY, which
    :func:`_is_verdict` explains is answered where it happens.

    Args:
        expl (Explanation): one command's explanation.
    """
    return expl.exit_code == 0 or _is_verdict(expl)


@dataclass(frozen=True, slots=True)
class Walked:
    """One command of a walked line, as both readers of the line see
    it: its words, the redirect targets of its statement, the session
    it is judged in, and where it stands.

    Args:
        words (list[Word]): the command's words, name first.
        redirects (tuple[Word, ...]): the statement's redirect targets.
        session (Session): the session the command is judged in.
        occurrence (Occurrence): the command's place on the line.
    """

    words: list[Word]
    redirects: tuple[Word, ...]
    session: Session
    occurrence: Occurrence


# A walk yields each command and returns the session its scope ends in,
# which is how a `cd` reaches the commands after it without escaping the
# child shell it ran in.
Walk = Generator[Walked, None, Session]


def _words_of(node: Any, home: str | None) -> list[Word]:
    """One command node's words, name first, the env prefix dropped.

    Args:
        node (Any): the command's tree-sitter node.
        home (str | None): the home directory a leading ``~`` names.
    """
    _, parts = split_env_prefix(get_parts(node))
    return [Word(get_text(part), literal_word(part, home)) for part in parts]


def _walk_node(node: Any, session: Session, home: str | None,
               frame: Frame) -> Walk:
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

    A substitution's body is walked in a frame of its own
    (``body_frame``): the nested line that evaluates it parses the body
    alone, under the substitution's node, and the commands in it have
    to be placed here exactly where that line will place them. A
    backtick region is walked as the lines it runs (``segment_frames``),
    each parsed here as the evaluator parses it.

    Args:
        node (Any): the tree-sitter node to walk.
        session (Session): the session this node begins in.
        home (str | None): the home directory a leading ``~`` names.
        frame (Frame): the scope the node is read in.
    """
    if node.type == NodeType.COMMAND:
        walked = session
        words = _words_of(node, home)
        if words:
            yield Walked(words, statement_redirects(node, home), session,
                         occurrence_in(node, frame))
            walked = _after_cd(words, session)
        for child in node.children:
            # A substitution among the words runs in its own shell.
            yield from _walk_node(child, session, home, frame)
        return walked
    if node.type in FORK_SCOPES:
        segments = segment_frames(node, frame)
        if segments:
            # A backtick region is read as the evaluator runs it: one
            # line per pair, parsed on its own, because tree-sitter
            # lexes touching pairs as one node whose subtree is not
            # what runs.
            for segment in segments:
                yield from _walk_node(parse(segment.text), session, home,
                                      segment)
            return session
        inner = body_frame(node, frame)
        yield from _walk_children(node, session, home,
                                  frame if inner is None else inner)
        return session
    if node.type == NodeType.PIPELINE:
        for child in node.children:
            yield from _walk_node(child, session, home, frame)
        return session
    return (yield from _walk_children(node, session, home, frame))


def _walk_children(node: Any, session: Session, home: str | None,
                   frame: Frame) -> Walk:
    """One scope's children in order, threading the cwd between them;
    returns the session the scope ends in.

    Args:
        node (Any): the tree-sitter node whose children form the scope.
        session (Session): the session the scope begins in.
        home (str | None): the home directory a leading ``~`` names.
        frame (Frame): the scope the children are read in.
    """
    walked = session
    children = node.children
    for index, child in enumerate(children):
        after = children[index + 1] if index + 1 < len(children) else None
        ended = yield from _walk_node(child, walked, home, frame)
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


def _walked_line(ast: Any,
                 session: Session,
                 frame: Frame | None = None) -> Iterator[Walked]:
    """Every command of a line with its redirect targets, the session
    it is judged in and its place on the line.

    The cwd is the one fact that moves as a line runs, and both readers
    of a line need the same answer about it: a host asking what a line
    would do and the pass deciding whether to let it run cannot differ,
    or ``explain`` would report an allow the run then refuses. The
    redirects ride along for the same reason: they are read here so both
    readers judge the file the shell opens, not just the operands.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        frame (Frame | None): the scope the line is read in; None
            reads ``ast`` as a line of its own.
    """
    if frame is None:
        frame = root_frame(ast, None)
    yield from _walk_node(ast, session, home_dir(session), frame)


async def prejudge_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
    agent_id: str = "",
    cancel: asyncio.Event | None = None,
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
        handed (HandOff): the line's hand-off, on which every grant
            claimed here rides to the executor's sweep.
        agent_id (str): the agent the line is attributed to.
        cancel (asyncio.Event | None): the run's kill channel. This
            pass puts real questions to a host, so it carries it
            exactly as the per-command gate does; without it a compound
            line asked here waited on an answer its own timeout could
            no longer cut short.

    Returns:
        The line's refusal, or None to run it.
    """
    judged: list[tuple[Walked, list[Judged]]] = []
    frame = root_frame(ast, handed.origin)
    for item in _walked_line(ast, session, frame):
        if item.words[0].text is None:
            continue
        judged.append(
            (item, await
             _judge_words(item.words, item.occurrence, item.session, registry,
                          namespace, agent_id, item.redirects)))
    if sum(len(explained) for _, explained in judged) < 2:
        return None
    for item, explained in judged:
        walked = item.session
        targets = redirect_paths(item.redirects, registry, walked.cwd)
        for index, one in enumerate(explained):
            expl = one.explanation
            if not _is_judged(expl) or not _asks_for(one):
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
                # _judge_words lists the statement's own command first
                # and the lines it runs after it, so only the first
                # explanation is the command the redirects belong to.
                redirects=targets if index == 0 else (),
                cancel=cancel,
                # This pass judges on the gate's behalf and runs nothing
                # itself, so a grant the host gives here is claimed for
                # the per-command gate that runs the line, and spent
                # when the line ends: one question per run, not per
                # pass.
                claimant=Claimant(handed, one.occurrence))
            if isinstance(answered, Refused):
                return answered
            # The host answered this one inline. The rest of the line
            # has not been judged yet, so the scan goes on: stopping
            # here let a later command's deny run behind an approval.
    return None


async def _verdict_refuses(
    judged: Judged,
    redirects: Sequence[PathSpec],
    walked: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    handed: HandOff,
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
        judged (Judged): the verdict's explanation and its occurrence.
        redirects (Sequence[PathSpec]): the statement's redirect
            targets, empty for a command that has none.
        walked (Session): the session the command is judged in.
        registry (MountRegistry): registry holding the policies and the
            decision ledger.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        handed (HandOff): the line's hand-off, on which an answer given
            here is claimed for the gate.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    expl = judged.explanation
    claimant = Claimant(handed, judged.occurrence)
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
    if isinstance(gated, Refused):
        return True
    ctx, asked = gated
    if not isinstance(asked, Ask):
        return isinstance(asked, Deny)
    standing = registry.decisions.held(ctx, asked, claimant)
    if standing is None:
        return False
    if isinstance(standing, Deny):
        return True
    # hand_off: this pass exists to decide whether a secret is fetched, and
    # the gate behind it still has to admit the line. An answer given here is
    # claimed for that gate, which runs on it -- so the host is asked once.
    action = await registry.decisions.resolve(ctx, asked, cancel, claimant)
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


def _sole_literal_command(node: Any, session: Session,
                          frame: Frame) -> Walked | None:
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
    agent_id: str,
    handed: HandOff,
    cancel: asyncio.Event | None,
) -> bool:
    """Whether one walked command is refused on its text, resolving an
    unanswered ask through the ledger the gate reads.

    Args:
        item (Walked): the command's words, redirect targets, the
            session it is judged in and its place on the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        handed (HandOff): the line's hand-off.
        cancel (asyncio.Event | None): the run's kill channel.
    """
    walked = item.session
    explained = await _judge_words(item.words, item.occurrence, walked,
                                   registry, namespace, agent_id,
                                   item.redirects)
    targets = redirect_paths(item.redirects, registry, walked.cwd)
    for index, judged in enumerate(explained):
        # A question about a spelling the runtime completes is the
        # gate's (``_asks_for``); the node is kept, and over-keeping
        # only ever over-fetches.
        if not _is_verdict(judged.explanation) or not _asks_for(judged):
            continue
        # _judge_words lists the statement's own command first and
        # the lines it runs after it, so only the first explanation
        # is the command the redirects belong to.
        if await _verdict_refuses(judged, targets if index == 0 else (),
                                  walked, registry, namespace, agent_id,
                                  handed, cancel):
            return True
    return False


async def unrefused_nodes(
    nodes: Sequence[Any],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    handed: HandOff,
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
        handed (HandOff): the line's hand-off, on which an approval
            given here is claimed for the gate.
        agent_id (str): the agent the line is attributed to.
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
        item = _sole_literal_command(node, session,
                                     root_frame(node, handed.origin))
        if item is None:
            out.append(node)
            continue
        if await _command_refused(item, registry, namespace, agent_id, handed,
                                  cancel):
            if position == 0:
                return []
            continue
        out.append(node)
    return out


async def _judge_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    frame: Frame,
    stated: bool = True,
) -> list[Judged]:
    """Every command of a line explained, in the order the gate reads
    them, each with its place on the line.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        frame (Frame): the scope the line is read in.
        stated (bool): whether the line's text reaches here as the gate
            will read it, as ``_judge_words`` takes it.
    """
    out: list[Judged] = []
    for item in _walked_line(ast, session, frame):
        out.extend(await _judge_words(item.words, item.occurrence,
                                      item.session, registry, namespace,
                                      agent_id, item.redirects, stated))
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
    judged = await _judge_line(ast, session, registry, namespace, agent_id,
                               root_frame(ast, None))
    return [one.explanation for one in judged]

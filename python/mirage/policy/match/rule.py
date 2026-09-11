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

import functools
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from mirage.policy.constants import (ASK_SECOND, DENY_FIRST, METADATA_OPS,
                                     SUBTREE_COMMANDS, SUBTREE_OPS)
from mirage.policy.match.allow import line_tokens
from mirage.policy.match.pattern import pattern_matches
from mirage.policy.types import (AdmissionRules, CommandContext, CommandRule,
                                 OpsContext)
from mirage.types import HiddenPaths, PathSpec
from mirage.utils.hidden import (anchor_depth, classify_paths, path_covers,
                                 path_hidden)


def better_match(current: tuple[int, int] | None, depth: int,
                 verb: int) -> bool:
    """Whether a match beats the best one so far: deeper anchor first,
    then the stronger verb, then the earlier rule (which is why this is
    strict).

    Shared by ``decide`` and :func:`io_refusal` so a line and the
    entries it reaches mid-walk are read by one law.

    Args:
        current (tuple[int, int] | None): the best (depth, verb) so far.
        depth (int): the candidate's anchor depth.
        verb (int): ``DENY_FIRST`` or ``ASK_SECOND``.
    """
    if current is None:
        return True
    best_depth, best_verb = current
    if depth != best_depth:
        return depth > best_depth
    return verb < best_verb


@dataclass(frozen=True, slots=True)
class RuleMatch:
    """A rule that applies to a line, and how far it reaches.

    ``match_rule`` returns None when the rule does not apply, a
    RuleMatch with ``operand`` None when the rule refuses (or asks
    about) the whole line, and a RuleMatch naming the operand when the
    rule is path-scoped and one operand fell under its paths, so the
    refusal is scoped to that operand (``rm: x: <reason>``, exit 1)
    rather than to the command (``rm: Permission denied``, 126).

    Args:
        operand (str | None): the operand as typed that a path-scoped
            rule matched; None when the rule reaches the whole line.
        depth (int): the anchor depth of the deepest entry that
            actually covered the operand, which is what the path axis
            orders by. Scoring the rule's deepest entry instead would
            lend an unrelated entry's depth to this match: an ask on
            ``/repo/*`` and ``/else/very/deep/*`` would outrank a deny
            anchored at ``/repo/private/*`` and reopen it. 0 when the
            rule names no paths, which is off the path axis entirely.
    """

    operand: str | None
    depth: int = 0


@dataclass(frozen=True, slots=True)
class Subject:
    """One thing a line's rules are read against.

    A line is judged subject by subject, because the paths a command
    names are not one question: ``cp /sealed/x /wip/y`` reads one file
    and writes another, and a nod for the destination says nothing
    about the source.

    Args:
        path (PathSpec | None): the path, None for the line itself,
            which is the only subject of a line naming no path and is
            reached only by a rule naming no paths.
        holds (bool): whether this subject would take a whole subtree
            along (``rm -r /x``, ``mv /x /y``), so a rule anchored
            below it speaks about it.
        ancestors (bool): whether an ancestor of the rule's scope
            counts as holding it; False for ``mv``'s destination, which
            lands in the scope only when it is that directory itself.
    """

    path: PathSpec | None
    holds: bool = False
    ancestors: bool = True


def subjects(ctx: CommandContext) -> tuple[Subject, ...]:
    """What a line's rules are read against, in the order they are read.

    Every path the line names first, each asked whether it lies inside
    a rule's scope; then the operands of a subtree command, asked the
    second question, whether they hold one. The two orders together are
    what a single rule sees, so the first subject a rule reaches is the
    operand its refusal names. A line naming no path is one subject,
    itself.

    Args:
        ctx (CommandContext): the classified command.
    """
    if not ctx.paths:
        return (Subject(None), )
    subs = [Subject(p) for p in ctx.paths]
    if ctx.command in SUBTREE_COMMANDS:
        operands = list(ctx.operands)
        dst = (operands.pop()
               if ctx.command == "mv" and len(operands) > 1 else None)
        subs.extend(Subject(p, holds=True) for p in operands)
        if dst is not None:
            subs.append(Subject(dst, holds=True, ancestors=False))
    return tuple(subs)


def _under(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")


def _touches(mount: str, ctx: CommandContext) -> bool:
    """Whether a line works inside a mount: its cwd is under the root,
    one of its paths is, or the command walks a directory holding the
    root (``grep -r x /scratch`` enters ``/scratch/child``: the fan-out
    reruns the traversal inside each descendant mount and no admission
    fires again there, so the ancestor operand is the one place the
    mount's rule can speak).

    Args:
        mount (str): the mount root.
        ctx (CommandContext): the classified command.
    """
    if _under(ctx.cwd, mount):
        return True
    if any(_under(p.virtual, mount) for p in ctx.paths):
        return True
    return ctx.walks and any(_under(mount, p.virtual) for p in ctx.paths)


def rule_applies(rule: CommandRule, ctx: CommandContext) -> bool:
    """Whether a rule speaks about a line at all, before any of the
    line's subjects is read.

    Two questions: the rule's command patterns (a prefix of the line's
    tokens; none means every command), and the rule's mount (a rule
    written under a mount section applies only to a line working inside
    it).

    Args:
        rule (CommandRule): the rule.
        ctx (CommandContext): the classified command.
    """
    if rule.commands:
        tokens = line_tokens(ctx)
        if not any(pattern_matches(p, tokens) for p in rule.commands):
            return False
    return not rule.mount or _touches(rule.mount, ctx)


def rule_reach(rule: CommandRule, scope: HiddenPaths | None,
               subject: Subject) -> int | None:
    """How deep a rule reaches at one subject of a line, None when it
    says nothing about that subject.

    A rule naming no paths reaches every subject at depth 0: it is off
    the path axis, so any entry naming a place outranks it. A rule
    carrying paths reaches a subject lying inside them, or, for a
    subtree operand, one holding them (``rm -r /x`` takes
    ``/x/locked/*`` along, and ``mv``'s destination lands in the scope
    only when it is that directory itself). The depth is the deepest
    entry that actually reached, never the rule's deepest entry.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's paths, classified once
            through ``classify_paths``; None when the rule names none.
        subject (Subject): one subject of the line.
    """
    if scope is None:
        return 0
    if subject.path is None:
        return None
    virtual = subject.path.virtual
    if path_hidden(scope, virtual):
        return hidden_depth(rule, virtual)
    if subject.holds and path_covers(scope, virtual, subject.ancestors):
        return covers_depth(rule, virtual, subject.ancestors)
    return None


def matched_operand(rule: CommandRule, subject: Subject) -> str | None:
    """The operand a rule's refusal names, as typed: the subject it
    reached, or None when the rule names no paths and so refuses the
    whole line.

    Args:
        rule (CommandRule): the rule that spoke.
        subject (Subject): the subject it reached.
    """
    if not rule.paths or subject.path is None:
        return None
    return subject.path.raw_path or subject.path.virtual


def match_rule(rule: CommandRule, scope: HiddenPaths | None,
               ctx: CommandContext) -> RuleMatch | None:
    """Whether one rule applies to a line, and to which operand: the
    first subject it reaches, which is what a single rule read as a
    policy of its own has to answer.

    ``decide`` does not use this, because a line is more than its first
    match: it reads every rule at every subject
    (:func:`subjects`, :func:`rule_reach`) so one operand's ask cannot
    speak for another operand's deny.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's paths, classified once
            through ``classify_paths``; None when the rule names none.
        ctx (CommandContext): the classified command.
    """
    if not rule_applies(rule, ctx):
        return None
    for subject in subjects(ctx):
        depth = rule_reach(rule, scope, subject)
        if depth is None:
            continue
        return RuleMatch(operand=matched_operand(rule, subject), depth=depth)
    return None


@functools.lru_cache(maxsize=1024)
def _entry_scope(entry: str) -> HiddenPaths | None:
    """One document entry, classified alone so it can be scored on its
    own; remembered, since a rule is re-read on every line.

    Args:
        entry (str): one entry of a rule's ``paths``.
    """
    return classify_paths((entry, ))


def hidden_depth(rule: CommandRule, virtual: str) -> int:
    """The anchor depth of the deepest entry of a rule that holds this
    path, 0 when none does.

    Args:
        rule (CommandRule): the rule that matched.
        virtual (str): absolute virtual path the rule matched on.
    """
    return max((anchor_depth(e)
                for e in rule.paths if path_hidden(_entry_scope(e), virtual)),
               default=0)


def covers_depth(rule: CommandRule,
                 virtual: str,
                 ancestors: bool = True) -> int:
    """The anchor depth of the deepest entry of a rule that sits at or
    under this path, 0 when none does.

    The subtree counterpart of :func:`hidden_depth`, for an operand
    that would take the scope along rather than lie inside it.

    Args:
        rule (CommandRule): the rule that matched.
        virtual (str): absolute virtual path of the subtree operand.
        ancestors (bool): whether an ancestor of the scope counts.
    """
    return max((anchor_depth(e) for e in rule.paths
                if path_covers(_entry_scope(e), virtual, ancestors)),
               default=0)


@functools.lru_cache(maxsize=1024)
def rule_scope(rule: CommandRule) -> HiddenPaths | None:
    """A rule's paths, classified once and remembered: None when the
    rule names none, so a caller can tell a whole-line rule from a
    path-scoped one without re-reading the document grammar.

    Args:
        rule (CommandRule): the rule, which is frozen and so a key.
    """
    return classify_paths(rule.paths)


def match_io(rule: CommandRule, scope: HiddenPaths | None,
             tokens: Sequence[str], virtual: str) -> bool:
    """Whether a rule reaches an entry a command touches on its own,
    below its operands: the rule names the line (its command patterns
    against the line's tokens, none meaning every command) and its
    paths hold the entry. A rule with no paths spoke about the whole
    line at admission and has nothing to add at an entry; the
    directory holding a scope is not in it, so a listing still shows
    a refused entry's name, which is what deny means: present, and
    refused.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        tokens (Sequence[str]): the line as an admission pattern reads
            it, command name first.
        virtual (str): absolute virtual path of the entry.
    """
    if scope is None:
        return False
    if rule.commands and not any(
            pattern_matches(p, tokens) for p in rule.commands):
        return False
    return path_hidden(scope, virtual)


def io_refusal(rules: AdmissionRules | None, tokens: Sequence[str],
               virtual: str, granted: Collection[CommandRule]) -> str | None:
    """The reason a command may not touch an entry it reached on its
    own, None when it may.

    The same law the admission gate applies to a line, and literally
    the same comparison (:func:`better_match`): anchor depth first,
    deny before ask at equal depth. Reading every deny before any ask
    instead would let a broad deny on ``/repo/*`` overrule an approved
    ask on ``/repo/sealed/*`` that the gate had just admitted the line
    under, so the carve-out would survive admission and then refuse
    every entry it was written for.

    The winning rule then answers: a deny refuses, an ask refuses
    unless the line holds a grant under it (the nod the gate took for
    ``rm -r /x`` covers the entries under ``/x``; a walk that wanders
    into an asked scope from outside gets no nod mid-command, so it is
    refused and the agent names the path to be asked).

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        tokens (Sequence[str]): the line's tokens, command name first.
        virtual (str): absolute virtual path of the entry.
        granted (Collection[CommandRule]): the ask rules the line runs
            under a grant for.
    """
    if rules is None:
        return None
    best: tuple[int, int] | None = None
    chosen: tuple[CommandRule, int] | None = None
    for verb, written in ((DENY_FIRST, rules.deny), (ASK_SECOND, rules.ask)):
        for rule in written:
            if not match_io(rule, rule_scope(rule), tokens, virtual):
                continue
            depth = hidden_depth(rule, virtual)
            if not better_match(best, depth, verb):
                continue
            best = (depth, verb)
            chosen = (rule, verb)
    if chosen is None:
        return None
    rule, verb = chosen
    if verb == ASK_SECOND and rule in granted:
        return None
    return rule.reason


def op_reach(rule: CommandRule, scope: HiddenPaths | None,
             ctx: OpsContext) -> int | None:
    """The anchor depth at which a rule reaches an op, None when it does
    not reach it at all.

    Only a pure path rule can, since an op does not know which command
    issued it. The op's path is tested against the scope, and an op that
    moves or removes a whole subtree (``SUBTREE_OPS``) is also reached on
    the directory holding the scope or on any ancestor, since it would
    take the scope along. A metadata op (``METADATA_OPS``) is reached by
    nothing: deny is present and refused, so the entry stats and its
    content is what the door withholds.

    The op-door twin of :func:`rule_reach`, and the same shape: the
    depth is the one the arm that matched measures, so a rule cannot
    lend an operand specificity from an entry that said nothing about
    it.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        ctx (OpsContext): the op about to run.
    """
    if rule.commands or scope is None or ctx.op in METADATA_OPS:
        return None
    virtual = ctx.path.virtual
    if path_hidden(scope, virtual):
        return hidden_depth(rule, virtual)
    if ctx.op in SUBTREE_OPS and path_covers(scope, virtual):
        return covers_depth(rule, virtual)
    return None


def match_op(rule: CommandRule, scope: HiddenPaths | None,
             ctx: OpsContext) -> bool:
    """Whether a rule refuses an op. The boolean case of
    :func:`op_reach`.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        ctx (OpsContext): the op about to run.
    """
    return op_reach(rule, scope, ctx) is not None


def op_refusal(rules: AdmissionRules | None, ctx: OpsContext,
               granted: Collection[CommandRule]) -> str | None:
    """The reason an op may not run, None when it may.

    The op-door twin of :func:`io_refusal`, and the same law: anchor
    depth first, deny before ask at equal depth, and an ask satisfied
    by a grant the line already holds. Reading every deny before any
    ask instead let a broad deny on ``/repo/*`` overrule an approved
    ask on ``/repo/outbox/*``, so the carve-out the command door had
    just admitted the line under could not authorize the redirect it
    was written for: the write reached this door and was refused there.

    An op reached with no admitted command behind it (FUSE, the cache,
    the host's own facade) holds no grant, so an ask that wins here is
    a refusal like a deny: there is no line to ask about and this door
    cannot wait on a host.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        ctx (OpsContext): the op about to run.
        granted (Collection[CommandRule]): the ask rules the running
            line holds a grant under, empty when no command is bound.
    """
    if rules is None:
        return None
    best: tuple[int, int] | None = None
    chosen: tuple[CommandRule, int] | None = None
    for verb, written in ((DENY_FIRST, rules.deny), (ASK_SECOND, rules.ask)):
        for rule in written:
            depth = op_reach(rule, rule_scope(rule), ctx)
            if depth is None or not better_match(best, depth, verb):
                continue
            best = (depth, verb)
            chosen = (rule, verb)
    if chosen is None:
        return None
    rule, verb = chosen
    if verb == ASK_SECOND and rule in granted:
        return None
    return rule.reason

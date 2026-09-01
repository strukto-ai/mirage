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

import logging
from collections.abc import Mapping, Sequence

import tree_sitter

from mirage.commands.cli.walk import invoked_env_names, supplied_env_names
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.table import VFSRuntime
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import fetch_secret
from mirage.secrets.summary import field_summary
from mirage.secrets.types import ResolvedSource
from mirage.shell.constants import SHOPT_DEFAULTS
from mirage.shell.parse import (arith_reads, assignment_values,
                                command_invocations, command_words, env_reads,
                                identifier_names, implicit_reads, opaque_reads,
                                parse, referenced_names)
from mirage.shell.variable import ManagedRef, VarAttr, with_value
from mirage.utils.hidden import var_hidden
from mirage.workspace.lookup.lookup import lookup
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.state import deref

logger = logging.getLogger(__name__)

# Appended to an alias value before parsing it for the read walk: the
# rest of the invoking line lands there at dispatch, so the trailing
# command's arguments are statically unknowable, never absent. "$@" is
# bash's own spelling for those words, and it parses as a special
# variable no read walk collects -- a synthetic *name* here would be a
# real variable a workspace could manage, and every alias would read it.
_ALIAS_REST = ' "$@"'


def _defined_bodies(
        node: tree_sitter.Node) -> dict[str, list[tree_sitter.Node]]:
    """Function bodies the line itself defines, every one per name.

    A name defined more than once on the line keeps every body: which
    definition an invocation runs depends on where it sits between them
    (``f() { :; }; f; f() { ...; }; f`` runs both), so all of them may
    be selected.

    Args:
        node (tree_sitter.Node): the parsed line.
    """
    out: dict[str, list[tree_sitter.Node]] = {}
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == "function_definition":
            name_node = current.child_by_field_name("name")
            body = current.child_by_field_name("body")
            text = name_node.text if name_node is not None else None
            if text and body is not None:
                out.setdefault(text.decode(), []).append(body)
        stack.extend(current.named_children)
    return out


def line_nodes(node: tree_sitter.Node,
               session: Session) -> list[tree_sitter.Node]:
    """The line's tree plus every body its command words can run.

    A body runs at invocation, not where it is defined, so the read
    walks skip definition subtrees; this is where an invoked body joins
    back in. A command word pulls in every body it could select, all
    of them rather than the likeliest: the session's stored function
    AND the line's own redefinition (``f; f() { :; }`` runs the stored
    body first, so neither may shadow the other), and a stored alias's
    expansion, parsed here because dispatch reparses it after this pass
    has already run. Alias values join only under ``expand_aliases``,
    the same gate ``alias_value`` applies at dispatch. Each name
    resolves once, so mutual recursion terminates; over-selection only
    ever over-fetches, under-selection is the bug.

    Args:
        node (tree_sitter.Node): the parsed line.
        session (Session): the session the line runs in (stored
            functions, aliases, shopts).
    """
    defined = _defined_bodies(node)
    expand = session.shopts.get("expand_aliases",
                                SHOPT_DEFAULTS["expand_aliases"])
    nodes: list[tree_sitter.Node] = [node]
    seen: set[str] = set()
    frontier: list[tree_sitter.Node] = [node]
    while frontier:
        current = frontier.pop()
        for word in command_words(current):
            if word in seen:
                continue
            seen.add(word)
            bodies = list(session.functions.get(word) or ())
            bodies.extend(defined.get(word) or ())
            if expand and word in session.aliases:
                # An alias is a textual prefix: dispatch appends the
                # invocation's rest to the value, so the value's
                # trailing command is parsed with a dynamic rest-word.
                # That keeps its argument list honest -- a CLI named in
                # an alias reads as "verbs unknowable" (whole spec
                # tree) rather than "no verb selected".
                bodies.append(parse(session.aliases[word] + _ALIAS_REST))
            nodes.extend(bodies)
            frontier.extend(bodies)
    return nodes


def guest_bound(nodes: Sequence[tree_sitter.Node],
                decision: RouteDecision | None,
                static_bindings: Mapping[str, Runtime | None]) -> bool:
    """Whether any of the line's commands runs on a guest runtime.

    A guest receives the exported environment as one snapshot, so
    every managed name may be read whatever the line spells --
    ``python3 -c 'os.environ[...]'`` never writes a ``$NAME`` the walk
    could see. The vfs runtime is the executor itself, whose commands
    read vars one at a time, so it does not count. Keyed on the walked
    set's own command words (stored function bodies included) because
    the static table binds every captured command in the workspace, not
    this line's.

    Args:
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        decision (RouteDecision | None): the line's placement decision,
            None when only static bindings apply.
        static_bindings (Mapping[str, Runtime | None]): the registry's
            standing command bindings, the fallback ``whole_line`` uses.
    """
    bindings = (decision.bindings if decision is not None else static_bindings)
    if not bindings:
        return False
    words: set[str] = {"*"}
    for node in nodes:
        words |= command_words(node)
    for word in words:
        runtime = bindings.get(word)
        if runtime is not None and not isinstance(runtime, VFSRuntime):
            return True
    return False


def cli_env_names(nodes: Sequence[tree_sitter.Node], session: Session,
                  registry: MountRegistry) -> frozenset[str]:
    """Env names the line's installed CLIs are about to read.

    An installed CLI reads a managed name through ``Option.env`` with
    no ``$NAME`` in the line's text, so the fill set has to be told. A
    head word counts only when dispatch would actually run the CLI
    (``lookup``): a function, builtin or namespace command shadowing
    the name wins routing, and a head the session's profile hides never
    runs at all. The invocation's literal words then prune the tree
    (``invoked_env_names``), so ``ntn api get`` contributes the api and
    get chain rather than every sibling verb's options, minus the
    options the invocation itself supplies (``supplied_env_names``):
    typed outranks environment, so the parser never reads those.

    Args:
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        session (Session): the session the line runs in.
        registry (MountRegistry): the registry holding the installs.
    """
    out: set[str] = set()
    for node in nodes:
        for head, args in command_invocations(node):
            if head is None:
                continue
            install = registry.clis.get(head)
            if install is None:
                continue
            if lookup(head, session, registry) is not Consumer.CLI:
                continue
            literal = [arg for arg in args if arg is not None]
            if len(literal) != len(args):
                out |= invoked_env_names(install.spec, None)
                continue
            words = frozenset(arg for arg in literal
                              if not arg.startswith("-"))
            out |= (invoked_env_names(install.spec, words) -
                    supplied_env_names(install.spec, literal))
    return frozenset(out)


# A prefix assignment's value may carry expansions (the walk reads
# them), but a substitution runs commands of its own, which is exactly
# the "nothing runs before the masks land" premise the prefix trades on.
_MASK_VALUE_BLOCKERS = frozenset(
    {"command_substitution", "process_substitution"})


def _replacement_blocked(part: tree_sitter.Node) -> bool:
    """Whether an assignment's subtree defeats the masking premise.

    A command or process substitution runs code before the prefix is
    over, and an opaque read (``${!name}``) reads a name no walk can
    spell, so neither may sit inside a masking statement.

    Args:
        part (tree_sitter.Node): one ``variable_assignment`` node.
    """
    if opaque_reads(part):
        return True
    stack = list(part.named_children)
    while stack:
        current = stack.pop()
        if current.type in _MASK_VALUE_BLOCKERS:
            return True
        stack.extend(current.named_children)
    return False


def _assignment_masks(stmt: tree_sitter.Node) -> frozenset[str] | None:
    """The names a standalone assignment statement definitely replaces.

    None when the statement is not a plain replacement: a ``+=`` reads
    the standing value into the result, a subscript writes one element,
    a substitution in the value runs code mid-prefix, and a declaration
    operand that is not an assignment (a flag word, a bare name) leaves
    the statement's effect to the builtin's own rules.

    Args:
        stmt (tree_sitter.Node): a ``variable_assignment``,
            ``variable_assignments`` or ``declaration_command``
            statement node.
    """
    parts = ([stmt] if stmt.type == "variable_assignment" else list(
        stmt.named_children))
    names: set[str] = set()
    for part in parts:
        if part.type != "variable_assignment":
            return None
        if any(child.type == "+=" for child in part.children):
            return None
        name_node = part.child_by_field_name("name")
        if name_node is None or name_node.type != "variable_name":
            return None
        text = name_node.text
        if not text:
            return None
        if _replacement_blocked(part):
            return None
        names.add(text.decode())
    return frozenset(names)


# The declaring builtins whose plain assignments land like ``X=v``:
# ``declare``/``typeset``/``export``/``readonly`` assign in any
# context. ``local`` is gated on the body flag because outside a
# function it refuses without writing, so the standing value stays
# readable.
_DECLARATION_MASK_HEADS = frozenset(
    {b"declare", b"typeset", b"export", b"readonly"})


def _declaration_replaces(stmt: tree_sitter.Node, in_body: bool) -> bool:
    """Whether a declaration statement's assignments land as writes.

    Args:
        stmt (tree_sitter.Node): a ``declaration_command`` statement.
        in_body (bool): the statement sits in a function body, where
            ``local`` writes; at top level it refuses without writing.
    """
    head = stmt.children[0].text if stmt.children else None
    if head == b"local":
        return in_body
    return head in _DECLARATION_MASK_HEADS


def _unset_masks(stmt: tree_sitter.Node) -> frozenset[str] | None:
    """The names a plain ``unset`` statement definitely removes.

    None when anything is unprovable: a flag other than ``-v``/``--``
    (``-f`` touches functions, ``-n`` the nameref itself), an operand
    no static read can spell, or a head that is not ``unset`` at all
    (the grammar parses ``unsetenv`` into the same node type, and no
    builtin answers it).

    Args:
        stmt (tree_sitter.Node): an ``unset_command`` statement node.
    """
    head = stmt.children[0].text if stmt.children else None
    if head != b"unset":
        return None
    names: set[str] = set()
    for child in stmt.named_children:
        if child.type == "word":
            text = child.text
            if not text or text.decode() not in ("-v", "--"):
                return None
        elif child.type == "variable_name":
            text = child.text
            if not text:
                return None
            names.add(text.decode())
        else:
            return None
    return frozenset(names)


def masked_names(node: tree_sitter.Node,
                 session: Session,
                 writes_gated: bool,
                 in_body: bool = False,
                 before: tree_sitter.Node | None = None) -> frozenset[str]:
    """Names one unit definitely replaces before anything can read them.

    The unit's leading run of plain statements that only assign,
    declare-with-value or unset masks its names for everything after:
    the write lands before any command runs, invoked bodies and CLIs
    only run from later statements, and even an opaque read there
    observes the replacement. The prefix ends at the first statement
    that is anything else, that runs in the background (``&`` detaches
    it to a subshell, so nothing persists), or that touches a readonly
    name (the write fails and the standing value stays observable). A
    name read while still unmasked (``TOKEN=$TOKEN``) stays fetched:
    within a statement the read precedes the write.

    The unit is the typed line for the top-level prefix, and a defined
    body for that body's own reads (``_own_masks``); ``in_body`` says
    which, because ``local`` writes only inside a function and refuses
    at top level with the standing value still readable.

    ``writes_gated`` empties the set: a ``pre_session`` policy may
    refuse a write mid-line while later statements still run, and a
    refused mask would leave the standing value readable, so under such
    a policy nothing masks and the fetch keeps today's shape.

    Args:
        node (tree_sitter.Node): the unit's parsed tree -- the line's
            own, one defined body's, or a stored statement's parent
            container (with ``before`` naming the statement).
        session (Session): the session the line runs in.
        writes_gated (bool): a policy hooks ``pre_session``.
        in_body (bool): the unit is a function body, where ``local``
            assigns.
        before (tree_sitter.Node | None): stop at this child, so a
            stored statement is discounted by exactly the prefix that
            runs before it and never by its own writes.
    """
    if writes_gated:
        return frozenset()
    masked: set[str] = set()
    needed: set[str] = set()
    children = node.children
    for idx, stmt in enumerate(children):
        if before is not None and stmt.id == before.id:
            break
        if not stmt.is_named or stmt.type == "comment":
            continue
        if stmt.type in ("variable_assignment", "variable_assignments"):
            masks = _assignment_masks(stmt)
        elif stmt.type == "declaration_command":
            masks = (_assignment_masks(stmt) if _declaration_replaces(
                stmt, in_body) else None)
        elif stmt.type == "unset_command":
            masks = _unset_masks(stmt)
        else:
            break
        if masks is None:
            break
        following = children[idx + 1] if idx + 1 < len(children) else None
        if following is not None and following.type == "&":
            break
        readonly = any(name in session.vars
                       and VarAttr.READONLY in session.vars[name].attrs
                       for name in masks)
        if readonly:
            break
        for name in referenced_names(stmt):
            for target in (name, deref(session, name)):
                if target not in masked:
                    needed.add(target)
        masked |= masks
    return frozenset(masked - needed)


# A defined body joins the walk as one of these containers; an alias
# parses to a program, the shape the typed line has.
_BODY_CONTAINERS = frozenset({"compound_statement", "subshell"})


def _own_masks(node: tree_sitter.Node, session: Session,
               writes_gated: bool) -> frozenset[str]:
    """A walked unit's own leading masks, discounting its own reads.

    A defined body's prefix masks the body's later reads exactly as the
    line's prefix masks the line's: the body runs its statements in
    order, so ``local TOKEN=x`` shadows before anything after it can
    read, whatever scope the invocation runs in. An alias expansion is
    a program run mid-line, where ``local`` refuses without writing, so
    only the context-free forms mask there. A stored body joins as its
    statements, one node each (the granularity the per-statement policy
    pass judges at), but the stored list keeps the original container
    alive, so each statement recovers its body scope through its
    parent: the prefix that runs before it (``before``) discounts its
    reads exactly as a same-line body's prefix would.

    Args:
        node (tree_sitter.Node): one walked unit past the line itself.
        session (Session): the session the line runs in.
        writes_gated (bool): a policy hooks ``pre_session``.
    """
    own: frozenset[str] = frozenset()
    if node.type in _BODY_CONTAINERS:
        own = masked_names(node, session, writes_gated, in_body=True)
    elif node.type == "program":
        own = masked_names(node, session, writes_gated)
    parent = node.parent
    if parent is not None and parent.type in _BODY_CONTAINERS:
        own |= masked_names(parent,
                            session,
                            writes_gated,
                            in_body=True,
                            before=node)
    return own


def _assigned_reach(
        nodes: Sequence[tree_sitter.Node]
) -> dict[str, tuple[set[str], set[str]]]:
    """What the line's own assignments may leave in each target.

    Per target name, the literal values assigned anywhere in the walked
    set and, for dynamic values, the names those values read. Both feed
    the arithmetic chase: an arithmetic read of the target recurses
    into whichever value lands, and ordering is not modelled -- every
    candidate counts, which only over-fetches.

    Args:
        nodes (Sequence[tree_sitter.Node]): the line's walked set.
    """
    out: dict[str, tuple[set[str], set[str]]] = {}
    for node in nodes:
        for name, literal, reads in assignment_values(node):
            values, names = out.setdefault(name, (set(), set()))
            if literal is not None:
                values.add(literal)
            names.update(reads)
    return out


def _arith_targets(
        session: Session, names: frozenset[str],
        assigned: Mapping[str, tuple[set[str], set[str]]]) -> frozenset[str]:
    """Every name an arithmetic read may reach through stored values.

    Arithmetic resolution recurses: a name's value is evaluated as an
    expression of its own, so ``name=TOKEN; echo $((name))`` reads
    TOKEN. The chase follows each read name through its session value,
    its nameref target, and the line's own assignments
    (``_assigned_reach``), tokenizing values with ``identifier_names``.
    A pending managed name has no value yet, so the chase adds it and
    stops there: what its fetched value may spell is unknowable before
    the fetch. The executor closes that hole by planning again once the
    values land, so a fetched value naming another managed variable is
    reached on the next pass.

    Args:
        session (Session): the session the line runs in.
        names (frozenset[str]): the unit's arithmetic reads.
        assigned (Mapping[str, tuple[set[str], set[str]]]): the line's
            assignment candidates per target.
    """
    out: set[str] = set()
    frontier = list(names)
    while frontier:
        name = frontier.pop()
        if name in out:
            continue
        out.add(name)
        target = deref(session, name)
        if target not in out:
            frontier.append(target)
        var = session.vars.get(name)
        value = var.value if var is not None else None
        # Any element of an array or map value may be the one the
        # recursion lands on (`arr=(TOKEN); $((arr))` reads arr[0]),
        # so every string in the structure is chased.
        if isinstance(value, str):
            frontier.extend(identifier_names(value))
        elif isinstance(value, dict):
            for item in value.values():
                frontier.extend(identifier_names(item))
        elif value is not None:
            for element in value:
                if element is not None:
                    frontier.extend(identifier_names(element))
        values, reads = assigned.get(name, (set(), set()))
        for literal in values:
            frontier.extend(identifier_names(literal))
        frontier.extend(reads)
    return frozenset(out)


def _wanted(session: Session, nodes: Sequence[tree_sitter.Node],
            pending: Mapping[str, ManagedRef], cli_env_names: frozenset[str],
            masked: frozenset[str], writes_gated: bool) -> frozenset[str]:
    """The pending names the line's walked set is about to read.

    An opaque read (``opaque_reads``) or a command head no static read
    can spell (``$tool api ...`` -- the program that runs is not
    decidable before expansion, so neither is its read set) selects
    everything pending; otherwise the set is the walk's references
    (nameref targets resolved through the session), the printing forms'
    explicit targets, the implicit reads (``implicit_reads``: a tilde
    reads ``$HOME``, a bare ``cd`` does too), the names an arithmetic
    read reaches through stored values (``_arith_targets``:
    ``name=TOKEN; echo $((name))`` reads TOKEN), the routed CLIs' env
    names, the eager-marked entries, and, when some command renders the
    whole environment, everything pending except what every such render
    provably skips (``env -u TOKEN``, an assignment prefix; the
    ``excluded`` third of ``env_reads``). Each walked unit's reads are
    discounted by that unit's own leading masks first (``_own_masks``:
    a body's ``local`` shadows its own later reads), and the line's
    masked names come off last, the opaque selections included: a
    masked name is replaced before anything at all runs, so whatever
    the line turns out to read observes the replacement, eagerness
    notwithstanding.

    Args:
        session (Session): the session the line runs in.
        nodes (Sequence[tree_sitter.Node]): the line's walked set.
        pending (Mapping[str, ManagedRef]): unfetched managed vars.
        cli_env_names (frozenset[str]): env names the line's installed
            CLIs read (``cli_env_names``).
        masked (frozenset[str]): names the line replaces before any
            read (``masked_names``).
        writes_gated (bool): a policy hooks ``pre_session``, so no
            unit's masks are trusted to land.
    """
    referenced: set[str] = set()
    printed: set[str] = set()
    implicit: set[str] = set()
    rendered_any = False
    rendered_excluded: frozenset[str] | None = None
    assigned = _assigned_reach(nodes)
    for position, node in enumerate(nodes):
        rendered, names, excluded = env_reads(node)
        if opaque_reads(node):
            return frozenset(pending.keys() - masked)
        if any(head is None for head, _ in command_invocations(node)):
            return frozenset(pending.keys() - masked)
        own = (_own_masks(node, session, writes_gated)
               if position else frozenset())
        if rendered:
            rendered_any = True
            rendered_excluded = (excluded if rendered_excluded is None else
                                 rendered_excluded & excluded)
        arith = arith_reads(node)
        if arith:
            referenced |= _arith_targets(session, arith, assigned) - own
        printed |= names - own
        implicit |= implicit_reads(node) - own
        referenced |= referenced_names(node) - own
    wanted = printed | implicit | cli_env_names | {
        name
        for name, ref in pending.items() if ref.eager
    }
    for name in referenced:
        wanted.add(name)
        wanted.add(deref(session, name))
    if rendered_any:
        wanted |= pending.keys() - (rendered_excluded or frozenset())
    return frozenset((wanted & pending.keys()) - masked)


def _pending(session: Session) -> dict[str, ManagedRef]:
    """The session's unfetched managed names, hidden ones excluded.

    A hidden name never fetches at all: the snapshot filters it and
    expansion reads it as unset, so no fetch could ever be visible.

    Args:
        session (Session): the session the line runs in.
    """
    out: dict[str, ManagedRef] = {}
    for name, var in session.vars.items():
        if var.managed is None or var.value is not None:
            continue
        if var_hidden(session.hidden_vars, name):
            continue
        out[name] = var.managed
    return out


def fill_names(session: Session,
               nodes: Sequence[tree_sitter.Node],
               *,
               whole: bool,
               cli_env_names: frozenset[str],
               writes_gated: bool = False) -> frozenset[str]:
    """The managed names one line is about to read, without fetching.

    Pure planning, split from :func:`fill_env` so the executor can
    consult the admission text-pass between deciding and fetching: a
    line already denied on its literal words never reaches a source.
    Masks come off each unit's own leading prefix: the line's, which
    ``line_nodes`` puts first, masks everything after it (a stored body
    or alias runs at an invocation point, after the masking prefix),
    and a defined body's masks only that body's reads (``_own_masks``).

    Args:
        session (Session): the session the line runs in.
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        whole (bool): the line runs as one opaque program (a whole-line
            runtime), so every managed name may be read.
        cli_env_names (frozenset[str]): env names the line's installed
            CLIs read (``cli_env_names``).
        writes_gated (bool): a policy hooks ``pre_session``, so no
            assignment or unset is trusted to land (``masked_names``).
    """
    pending = _pending(session)
    if not pending:
        return frozenset()
    if whole:
        return frozenset(pending)
    masked = (masked_names(nodes[0], session, writes_gated)
              if nodes else frozenset())
    return _wanted(session, nodes, pending, cli_env_names, masked,
                   writes_gated)


async def fill_env(
        session: Session,
        names: frozenset[str],
        sources: Mapping[str, ResolvedSource] | None = None) -> None:
    """Fetch the named managed values into the session.

    The session is the truth, not the workspace's declaration: it may
    carry entries the workspace never declared (per-session env, a
    hydrated record), and a var that already holds a value never
    refetches -- which also makes the re-entrant fill of a nested eval
    idempotent. Fetches group by ``(source, ref)``, one await per
    distinct secret, and the fetched value lands directly in
    ``session.vars`` with the pointer kept: this is the one host-tier
    writer, above the agent's gated door.

    A failed fetch, or a secret without the wanted field, raises
    SecretsError naming the variable and the source -- never the ref,
    never any value, and never the source's own words, which go to the
    host log instead (an SDK error can spell paths or identifiers, and
    stderr is the agent's to read). The executor folds it into the
    line's result (exit 1), so a dead source fails exactly the
    commands that need it.

    Args:
        session (Session): the session the line runs in, written here.
        names (frozenset[str]): the fetch set (``fill_names``).
        sources (Mapping[str, ResolvedSource] | None): the workspace's
            declared instances. A pointer naming one fetches through
            its configured source; a pointer naming none falls back to
            the source of that name, built from ambient defaults.
    """
    if not names:
        return
    pending = _pending(session)
    records = {name: session.vars[name] for name in pending}
    groups: dict[tuple[str, str], list[str]] = {}
    for name in sorted(names & pending.keys()):
        pointer = pending[name]
        groups.setdefault((pointer.source, pointer.ref), []).append(name)
    for (source, ref), group in groups.items():
        listed = ", ".join(group)
        # A declared instance is named by the deployment, so the
        # summary is told the source behind it: `{prod: {source: env}}`
        # must redact like `env`, not like an unknown name.
        declared = sources.get(source) if sources else None
        provider = declared.source if declared is not None else source
        try:
            secret = await fetch_secret(source, ref, sources)
        except Exception as exc:
            logger.warning("secret fetch for %s from %s failed: %s", listed,
                           source, exc)
            raise SecretsError(
                f"{listed}: cannot fetch from {source}") from exc
        for name in group:
            key = pending[name].key
            value = secret.fields.get(key)
            if value is None:
                raise SecretsError(
                    f"{name}: wanted field {key!r}, the {source} secret "
                    f"has {field_summary(secret.fields, provider)}")
            session.vars[name] = with_value(records[name], value)

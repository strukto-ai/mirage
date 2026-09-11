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

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from mirage.policy.constants import WILDCARD
from mirage.policy.errors import PolicyError
from mirage.policy.match.pattern import (intersect_patterns, pattern_matches,
                                         split_pattern)
from mirage.policy.types import (AdmissionRules, CommandRule, HideReason,
                                 ProfileScript)
from mirage.types import (HiddenPaths, HiddenVars, MountMode, ShowEntry,
                          ShownPaths, weaker_mode)
from mirage.utils.hidden import (anchor_depth, classify_paths, classify_shows,
                                 classify_vars, hide_depth, is_glob,
                                 show_depth, shown_mode)
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.session import Session, vars_from_env
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.validate import check_rules

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, CompiledProfile, MountCommandsBlock, PathsBlock,
    ProfileMount, SessionProfile, VarsBlock)


def resolve_profile(
    profiles: Mapping[str, SessionProfile],
    profile: str | SessionProfile | None,
) -> SessionProfile | None:
    """The profile a session is created from.

    A name is looked up as written; a profile object is itself; None
    picks ``profiles.default`` when the workspace defines one and
    leaves the session unrestricted otherwise. There is no inheritance
    chain: a profile is the whole document, so nothing is assembled from
    somewhere else before it is read.

    Args:
        profiles (Mapping[str, SessionProfile]): the workspace's named
            profiles.
        profile (str | SessionProfile | None): what ``create_session``
            was given.

    Raises:
        PolicyError: the name is not a profile the workspace defines.
    """
    if profile is None:
        return profiles.get(DEFAULT_PROFILE)
    if not isinstance(profile, str):
        return profile
    if profile not in profiles:
        raise PolicyError(f"unknown profile {profile!r}")
    return profiles[profile]


def _union_hide(a: PathsBlock | VarsBlock | None,
                b: PathsBlock | VarsBlock | None) -> tuple[str, ...]:
    """Every entry of both blocks, first spelling wins, order kept.

    Args:
        a (PathsBlock | VarsBlock | None): the profile's block.
        b (PathsBlock | VarsBlock | None): the inline block.
    """
    out: list[str] = []
    for block in (a, b):
        for entry in (block.hide if block is not None else ()):
            if entry not in out:
                out.append(entry)
    return tuple(out)


def refuse_allow(inline: CommandsBlock | None) -> None:
    """Refuse an allow list in an inline document.

    The refusal belongs to *where the document was written*, not to
    whether a profile happened to resolve, so both paths into
    ``with_inline`` run it: a workspace with no default profile must not
    quietly accept a list a workspace with one refuses.

    Args:
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is not None and inline.allow is not None:
        raise PolicyError("inline permissions may add ask and deny rules, "
                          "not an allow list")


def refuse_show(inline: SessionProfile) -> None:
    """Refuse a show entry in an inline document.

    An inline document may only restrict: it adds ask and deny rules
    and hides. A show re-opens a subtree or states a mode, which is the
    profile's to say; same rule as :func:`refuse_allow`, and it runs on
    both paths into ``with_inline`` for the same reason.

    Args:
        inline (SessionProfile): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states a show entry.
    """
    blocks = [inline.paths]
    blocks.extend(entry.paths for entry in (inline.mounts or {}).values())
    if any(block is not None and block.show for block in blocks):
        raise PolicyError("inline permissions may add ask and deny rules "
                          "and hides, not show entries")


def _add_commands(base: CommandsBlock | None,
                  inline: CommandsBlock | None) -> CommandsBlock | None:
    """The profile's commands block with the inline document's rules added.

    An inline document may only restrict, so it carries ask and deny
    rules and never an allow list: a list there would install a command
    the profile does not have, which is the one thing a per-call document
    must not do.

    Args:
        base (CommandsBlock | None): the profile's block.
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is None:
        return base
    refuse_allow(inline)
    if base is None:
        return inline
    return CommandsBlock(allow=base.allow,
                         ask=base.ask + inline.ask,
                         deny=base.deny + inline.deny)


def _add_mount(base: ProfileMount | None,
               inline: ProfileMount | None) -> ProfileMount:
    """One mount's entry with the inline document's added: the weaker
    mode, both rule lists, both hide lists.

    Args:
        base (ProfileMount | None): the profile's entry, None when it
            names no settings for this mount.
        inline (ProfileMount | None): the inline entry.
    """
    if base is None:
        return inline if inline is not None else ProfileMount()
    if inline is None:
        return base
    mode = base.mode
    if inline.mode is not None:
        mode = (inline.mode if mode is None else weaker_mode(
            mode, inline.mode))
    ask = _rules_of(base.commands, "ask") + _rules_of(inline.commands, "ask")
    deny = _rules_of(base.commands, "deny") + _rules_of(
        inline.commands, "deny")
    hide = _union_hide(base.paths, inline.paths)
    show = base.paths.show if base.paths is not None else ()
    reasons = _merge_reasons(base.paths, inline.paths)
    return ProfileMount(
        mode=mode,
        commands=(MountCommandsBlock(ask=ask, deny=deny) if
                  (ask or deny) else None),
        paths=(PathsBlock(hide=hide, show=show, reasons=reasons) if
               (hide or show or reasons) else None))


def _merge_reasons(a: PathsBlock | None,
                   b: PathsBlock | None) -> tuple[HideReason, ...]:
    """Both blocks' reason groups, the profile's first.

    Args:
        a (PathsBlock | None): the profile's block.
        b (PathsBlock | None): the inline block.
    """
    out: list[HideReason] = []
    for block in (a, b):
        if block is not None:
            out.extend(block.reasons)
    return tuple(out)


def _rules_of(block: MountCommandsBlock | None,
              verb: str) -> tuple[CommandRule, ...]:
    """One verb's rules in a mount entry's commands block, empty when
    unstated.

    Args:
        block (MountCommandsBlock | None): the entry's block.
        verb (str): ``ask`` or ``deny``.
    """
    if block is None:
        return ()
    return block.ask if verb == "ask" else block.deny


def with_inline(base: SessionProfile | None,
                inline: SessionProfile | None) -> SessionProfile | None:
    """A profile with the inline document of one ``create_session`` added.

    The one rule about combining two documents: an inline document may
    add ask and deny rules and hides, never an allow list and never a
    script, and that holds even when there is no profile to add to.
    Modes take the weaker of the two, ``cwd`` and ``env`` are the
    inline document's when it states them (they are session presets,
    not permissions). Either side None returns the other unchanged; the
    profile's policy survives the merge, since the inline document can
    only add rules beside it.

    Args:
        base (SessionProfile | None): the resolved profile.
        inline (SessionProfile | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list or a
            script.
    """
    if inline is None:
        return base
    refuse_allow(inline.commands)
    refuse_show(inline)
    if inline.policy is not None:
        raise PolicyError("inline permissions may add ask and deny rules, "
                          "not a policy; state one on the profile")
    if base is None:
        return inline
    hide_paths = _union_hide(base.paths, inline.paths)
    hide_vars = _union_hide(base.vars, inline.vars)
    env = None
    if base.env is not None or inline.env is not None:
        env = {**(base.env or {}), **(inline.env or {})}
    mounts: dict[str, ProfileMount] | None = None
    if base.mounts is not None or inline.mounts is not None:
        prefixes = [*(base.mounts or {})]
        prefixes.extend(p for p in (inline.mounts or {}) if p not in prefixes)
        mounts = {
            prefix:
            _add_mount((base.mounts or {}).get(prefix), (inline.mounts
                                                         or {}).get(prefix))
            for prefix in prefixes
        }
    return SessionProfile(
        cwd=inline.cwd if inline.cwd is not None else base.cwd,
        env=env,
        mounts=mounts,
        paths=(PathsBlock(hide=hide_paths,
                          show=base.paths.show if base.paths is not None else
                          (),
                          reasons=_merge_reasons(base.paths, inline.paths)) if
               (base.paths is not None or inline.paths is not None) else None),
        vars=(VarsBlock(hide=hide_vars) if
              (base.vars is not None or inline.vars is not None) else None),
        commands=_add_commands(base.commands, inline.commands),
        policy=base.policy,
    )


def _root_of(prefix: str) -> str:
    """One spelling for a mount prefix: leading slash, no trailing one.

    Args:
        prefix (str): the prefix as the document spells it.
    """
    return "/" + prefix.strip("/")


def _anchored(entries: tuple[str, ...], root: str) -> tuple[str, ...]:
    """A mount section's path entries, anchored to the mount they are
    written under.

    An absolute entry already names something inside the root
    (``_under_mount`` refuses one that does not) and is left as written.
    A name pattern (``*.pem``, no slash) anchors nothing, and both
    places a mount section's entries are read from have lost the
    section by then: the session's hidden set is one list for every
    mount, and the op door matches a rule's paths without consulting
    ``rule.mount``. Left raw, ``mounts./repo.paths.hide: ["*.pem"]``
    hid ``/other/key.pem`` too, and a path-only deny under ``/repo``
    refused a read of it. The dialect's ``*`` crosses ``/``, so
    ``/repo/*.pem`` is every ``.pem`` at any depth below ``/repo`` and
    nothing outside it; anchoring also gives the entry the mount's own
    anchor depth, which is what it was always worth.

    Args:
        entries (tuple[str, ...]): the entries as written.
        root (str): the mount root, leading slash, no trailing one.
    """
    return tuple(e if e.startswith("/") else f"{root.rstrip('/')}/{e}"
                 for e in entries)


def _scoped_rules(rules: tuple[CommandRule, ...],
                  root: str) -> tuple[CommandRule, ...]:
    """A mount entry's rules, stamped with the mount they belong to and
    anchored to it.

    The stamp is what makes the rule apply to a line that *works
    inside* the mount, by cwd or by operand, which a path-scoped rule
    cannot express. The anchor is for the entries the stamp cannot
    reach: the op door reads a rule's paths alone (:func:`_anchored`).

    Args:
        rules (tuple[CommandRule, ...]): the rules as written.
        root (str): the mount prefix, leading slash, no trailing one.
    """
    return tuple(
        CommandRule(reason=rule.reason,
                    commands=rule.commands,
                    paths=_anchored(rule.paths, root),
                    mount=root) for rule in rules)


def compile_commands(profile: SessionProfile) -> AdmissionRules | None:
    """A profile's admission rules: its own, plus every mount entry's,
    in one list; None when the profile states none.

    Mount rules come first so the entry closest to the data speaks
    first when several rules match at the same anchor depth and only
    the message differs.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    ask: list[CommandRule] = []
    deny: list[CommandRule] = []
    for prefix, entry in (profile.mounts or {}).items():
        root = _root_of(prefix)
        ask.extend(_scoped_rules(_rules_of(entry.commands, "ask"), root))
        deny.extend(_scoped_rules(_rules_of(entry.commands, "deny"), root))
    block = profile.commands
    allow = block.allow if block is not None else None
    if block is not None:
        ask.extend(block.ask)
        deny.extend(block.deny)
    if allow is None and not ask and not deny:
        return None
    return AdmissionRules(allow=allow, ask=tuple(ask), deny=tuple(deny))


def _hidden(profile: SessionProfile) -> HiddenPaths | None:
    """Every path the profile hides: its own entries, and each mount
    entry's anchored to the mount it was written under, since the set
    is one list for the whole session and nothing in it remembers which
    section an entry came from (:func:`_anchored`).

    Args:
        profile (SessionProfile): the resolved profile.
    """
    entries: list[str] = []
    if profile.paths is not None:
        entries.extend(profile.paths.hide)
    for prefix, entry in (profile.mounts or {}).items():
        if entry.paths is not None:
            entries.extend(_anchored(entry.paths.hide, _root_of(prefix)))
    return classify_paths(entries)


def _shown(profile: SessionProfile) -> ShownPaths | None:
    """Every show entry the profile states: its own and each mount
    section's, one list, since a show entry is absolute wherever it is
    written and the compiled axis has no sections.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    entries: list[ShowEntry] = []
    if profile.paths is not None:
        entries.extend(profile.paths.show)
    for entry in (profile.mounts or {}).values():
        if entry.paths is not None:
            entries.extend(entry.paths.show)
    return classify_shows(entries)


def _hide_reasons(profile: SessionProfile) -> tuple[HideReason, ...]:
    """The operator's reasons for grouped hides, a mount section's
    anchored to its mount exactly like the hide entries they describe,
    so the side table names what the compiled spec matches.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    groups: list[HideReason] = []
    if profile.paths is not None:
        groups.extend(profile.paths.reasons)
    for prefix, entry in (profile.mounts or {}).items():
        if entry.paths is not None:
            root = _root_of(prefix)
            groups.extend(
                HideReason(patterns=_anchored(g.patterns, root),
                           reason=g.reason) for g in entry.paths.reasons)
    return tuple(groups)


def _modes(profile: SessionProfile) -> dict[str, MountMode] | None:
    """The mode each mount section states, None when none does.

    A mount the profile does not name is absent from the map and keeps
    the mode it declares in the workspace's ``mounts:``; the map only
    narrows, it never grants.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    modes = {
        prefix: entry.mode
        for prefix, entry in (profile.mounts or {}).items()
        if entry.mode is not None
    }
    return modes or None


def compile_script(effective: SessionProfile,
                   name: str) -> ProfileScript | None:
    """The profile's per-command script, compiled onto the session.

    Args:
        effective (SessionProfile): the resolved profile.
        name (str): the profile's name, empty for a document passed
            without one; what the script reads as ``ctx["profile"]``.

    Raises:
        PolicyError: the policy is still a path, which means it reached
            the workspace without passing the config door that loads
            one.
    """
    policy = effective.policy
    if policy is None:
        return None
    if isinstance(policy.script, str):
        raise PolicyError(
            f"profile {name!r} names a policy by path "
            f"({policy.script!r}); only the config door loads one, pass "
            f"ScriptSource in code")
    return ProfileScript(profile=name,
                         script=policy.script,
                         runtime=policy.runtime)


def compile_profile(effective: SessionProfile | None,
                    name: str = "") -> CompiledProfile:
    """The session fields a profile compiles to.

    Args:
        effective (SessionProfile | None): the resolved profile with any
            inline document already added; None is an unrestricted
            session.
        name (str): the profile's name, empty for a document passed
            without one; carried onto its script for ``ctx["profile"]``,
            for refusals to print, and onto the session as the group an
            owner-rendering command shows.
    """
    if effective is None:
        return CompiledProfile(mount_modes=None,
                               hidden_paths=None,
                               hidden_vars=None,
                               env=None,
                               cwd=None,
                               commands=None,
                               profile=name or None)
    commands = compile_commands(effective)
    check_rules(commands)
    return CompiledProfile(
        mount_modes=_modes(effective),
        hidden_paths=_hidden(effective),
        hidden_vars=classify_vars(
            effective.vars.hide if effective.vars is not None else ()),
        env=dict(effective.env) if effective.env is not None else None,
        cwd=effective.cwd,
        commands=commands,
        script=compile_script(effective, name),
        shown_paths=_shown(effective),
        hide_reasons=_hide_reasons(effective),
        profile=name or None,
    )


def narrow(session: Session, compiled: CompiledProfile) -> None:
    """Stamp a compiled profile's narrowing onto a session.

    The fields no shell line can edit: the per-mount modes, hidden
    paths, show entries, hidden variables, hide reasons, the admission
    rules, the profile's policy, the profile's name. Applied at creation
    and again whenever a stored record could carry a stale copy (the
    default session after hydration), so the document, not the store,
    is what an agent runs under.

    Args:
        session (Session): the session to narrow.
        compiled (CompiledProfile): the effective profile.
    """
    session.mount_modes = (dict(compiled.mount_modes)
                           if compiled.mount_modes is not None else None)
    session.hidden_paths = compiled.hidden_paths
    session.shown_paths = compiled.shown_paths
    session.hidden_vars = compiled.hidden_vars
    session.hide_reasons = compiled.hide_reasons
    session.commands = compiled.commands
    session.script = compiled.script
    session.profile = compiled.profile


def narrowing_of(session: Session) -> CompiledProfile:
    """A session's narrowing read back as a compiled profile.

    What :func:`narrow` stamps, in the shape it stamps from, so a
    caller that narrows a live session speculatively can put the
    session back with ``narrow(session, saved)``. A restore does
    exactly that: it joins each table's profile onto the session
    before the ``pre_session`` gate runs, and a refusal there has to
    leave the workspace as it was. The scratch halves of a profile
    (``env``, ``cwd``) are not narrowing and are not read.

    Args:
        session (Session): the session to read.
    """
    return CompiledProfile(mount_modes=dict(session.mount_modes)
                           if session.mount_modes is not None else None,
                           hidden_paths=session.hidden_paths,
                           hidden_vars=session.hidden_vars,
                           env=None,
                           cwd=None,
                           commands=session.commands,
                           script=session.script,
                           shown_paths=session.shown_paths,
                           hide_reasons=session.hide_reasons,
                           profile=session.profile)


def narrow_profile(session: Session, compiled: CompiledProfile) -> None:
    """Join a profile onto a session that is already running, never wider.

    :func:`narrow` stamps a profile onto a session the host creates or
    resets; this adds one to a live session, which is what a restore
    does to the session a stored table lands on. A table names the
    profile its source session ran under, and the target's document of
    that name is what must govern the restored session — including its
    policy program, which the table cannot carry and
    :func:`narrow_restored` deliberately never takes off it. The join
    is :func:`narrow_restored`'s, for the same reason: restrictions
    union, grants intersect, so a session that has accumulated
    restrictions of its own keeps every one of them.

    The program is the profile's when the session runs none, and the
    session's when it does: a checkout must not swap out a program the
    host installed with ``set_session_profile``, which stays the host's
    reset. The name travels with the program, so a session never
    reports a group whose script it is not running.

    Args:
        session (Session): the live session.
        compiled (CompiledProfile): the target's profile of the name
            the table carries.
    """
    modes = _merge_modes(session.mount_modes, compiled.mount_modes)
    hidden = _merge_hidden_paths(session.hidden_paths, compiled.hidden_paths)
    shown = _merge_shown(
        _Side(session.mount_modes, session.hidden_paths, session.shown_paths),
        _Side(compiled.mount_modes, compiled.hidden_paths,
              compiled.shown_paths))
    session.hidden_vars = _merge_hidden_vars(session.hidden_vars,
                                             compiled.hidden_vars)
    session.hide_reasons = _merge_groups(session.hide_reasons,
                                         compiled.hide_reasons)
    session.commands = _merge_commands(session.commands, compiled.commands)
    if session.script is None:
        session.script = compiled.script
        session.profile = compiled.profile
    session.mount_modes = modes
    session.hidden_paths = hidden
    session.shown_paths = shown


def apply_profile(session: Session, compiled: CompiledProfile) -> None:
    """Narrow a fresh session and seed its scratch state from the profile.

    A profile's env is a *process* environment, the same shape
    ``ws.env = {...}`` speaks, so every name in it is exported: seeding
    them plain left ``$TOKEN`` expanding while every command, CLI and
    guest runtime in the profiled session saw nothing, since all three
    read ``env_snapshot`` and that is the exported set. The cwd is where
    the session starts; both are the agent's to change afterwards,
    which is why hydration keeps the stored ones and re-stamps only
    :func:`narrow`.

    Args:
        session (Session): the session just created.
        compiled (CompiledProfile): the effective profile.
    """
    narrow(session, compiled)
    if compiled.env:
        session.vars.update(vars_from_env(compiled.env))
    if compiled.cwd is not None:
        set_cwd(session, compiled.cwd)


def _dedupe(entries: Iterable[str]) -> tuple[str, ...]:
    """The entries in order, each spelling once.

    Args:
        entries (Iterable[str]): document entries, both sides' in turn.
    """
    out: list[str] = []
    for entry in entries:
        if entry not in out:
            out.append(entry)
    return tuple(out)


def _merge_modes(
        base: dict[str, MountMode] | None,
        table: dict[str, MountMode] | None) -> dict[str, MountMode] | None:
    """The weaker mode per prefix over both maps, prefixes normalized;
    the base map itself when the table narrows nothing.

    Args:
        base (dict[str, MountMode] | None): the session's caps.
        table (dict[str, MountMode] | None): the stored table's caps.
    """
    if table is None:
        return base
    merged = {_root_of(p): m for p, m in (base or {}).items()}
    for prefix, mode in table.items():
        root = _root_of(prefix)
        have = merged.get(root)
        merged[root] = mode if have is None else weaker_mode(have, mode)
    return base if base is not None and merged == base else merged


def _merge_hidden_paths(base: HiddenPaths | None,
                        table: HiddenPaths | None) -> HiddenPaths | None:
    """Both hide sets in one, the session's entries first; the
    session's own object when the table hides nothing new.

    Args:
        base (HiddenPaths | None): the session's spec.
        table (HiddenPaths | None): the stored table's spec.
    """
    if table is None:
        return base
    if base is None:
        return table
    merged = classify_paths(
        _dedupe((*base.paths, *base.patterns, *table.paths, *table.patterns)))
    return base if merged == base else merged


def _merge_hidden_vars(base: HiddenVars | None,
                       table: HiddenVars | None) -> HiddenVars | None:
    """Both hidden-variable sets in one, the session's first; the
    session's own object when the table hides nothing new.

    Args:
        base (HiddenVars | None): the session's spec.
        table (HiddenVars | None): the stored table's spec.
    """
    if table is None:
        return base
    if base is None:
        return table
    merged = classify_vars(
        _dedupe((*base.names, *base.patterns, *table.names, *table.patterns)))
    return base if merged == base else merged


def _merge_groups(base: tuple[HideReason, ...],
                  table: tuple[HideReason, ...]) -> tuple[HideReason, ...]:
    """The session's reason groups, then the table's it lacks.

    Args:
        base (tuple[HideReason, ...]): the session's groups.
        table (tuple[HideReason, ...]): the stored table's groups.
    """
    out = list(base)
    out.extend(group for group in table if group not in out)
    return base if len(out) == len(base) else tuple(out)


def _append_rules(base: tuple[CommandRule, ...],
                  table: tuple[CommandRule, ...]) -> tuple[CommandRule, ...]:
    """The session's rules, then the table's it lacks.

    Args:
        base (tuple[CommandRule, ...]): the session's rules of one verb.
        table (tuple[CommandRule, ...]): the stored table's.
    """
    out = list(base)
    out.extend(rule for rule in table if rule not in out)
    return base if len(out) == len(base) else tuple(out)


def _merge_allow(base: tuple[str, ...] | None,
                 table: tuple[str, ...] | None) -> tuple[str, ...] | None:
    """The allow list both sides grant.

    One side stating a list installs only what it lists, so that list
    stands when the other states none; two lists intersect pattern by
    pattern (``intersect_patterns``), which can only remove. The
    session's own list stands when the table spells the same set, so a
    table that adds nothing changes nothing.

    Args:
        base (tuple[str, ...] | None): the session's list.
        table (tuple[str, ...] | None): the stored table's list.
    """
    if table is None:
        return base
    if base is None or set(base) == set(table):
        return table if base is None else base
    return intersect_patterns(base, table)


def _shared_mount(mine: str, other: str) -> str | None:
    """The mount both rules speak inside, spelled as the deeper was.

    An empty mount is the whole session, so the other's stands; two
    mounts share the deeper when one lies under the other, and nothing
    when neither does, since no line's subject sits in both.

    Args:
        mine (str): the ask rule's mount, empty at the top level.
        other (str): the deny's mount, empty at the top level.
    """
    if not mine or not other:
        return mine or other
    a, b = _root_of(mine), _root_of(other)
    if a == b or b == "/" or a.startswith(b + "/"):
        return mine
    if a == "/" or b.startswith(a + "/"):
        return other
    return None


def _shared_commands(mine: tuple[str, ...],
                     other: tuple[str, ...]) -> tuple[str, ...] | None:
    """The command patterns both rules speak about, None when no line
    can match both.

    No pattern on a side means every command, so the other side's list
    stands; two lists meet token by token (``intersect_patterns``, so a
    ``git`` ask and a ``git push`` deny share ``git push``), and an
    empty meeting means the two rules never read the same line.

    Args:
        mine (tuple[str, ...]): the ask rule's patterns.
        other (tuple[str, ...]): the deny's patterns.
    """
    if not mine or not other:
        return mine or other
    return intersect_patterns(mine, other) or None


def _reach_above(deny: CommandRule, entry: str) -> int | None:
    """How deep a deny reaches an ask's path entry from above it.

    The anchor depth of the deny's deepest entry covering the ask's
    from higher up (the hide law's own covering test, since a rule's
    path entries are the same grammar); 0 for a pathless deny, which
    every placed entry outranks; None when the deny does not reach the
    entry, or reaches it at the entry's own depth, where the verb
    tie-break already lets it win.

    Args:
        deny (CommandRule): the candidate deny.
        entry (str): one path entry of an ask rule.
    """
    depth = anchor_depth(entry)
    if not deny.paths:
        return 0 if depth > 0 else None
    reached = [
        anchor_depth(path) for path in deny.paths
        if anchor_depth(path) < depth and hide_depth(classify_paths((
            path, )), entry) is not None
    ]
    return max(reached) if reached else None


def _shields(ask: CommandRule, entry: str, floor: int,
             commands: tuple[str, ...]) -> bool:
    """Whether a side's own ask already outranks its deny at an entry,
    so that side's answer there is a question and not a refusal.

    The ask has to cover the entry from below the deny's reach (the
    entry's own depth counts; a tie with the deny does not, since the
    deny wins it) and speak about every command the two rules share,
    because a narrower ask leaves the deny answering the rest. Its
    mount needs no check: a rule's entries lie under its mount, so a
    line the entry names touches it.

    Args:
        ask (CommandRule): one of the other side's own ask rules.
        entry (str): the path entry being restated.
        floor (int): the depth the deny reaches the entry from.
        commands (tuple[str, ...]): the shared command patterns, empty
            for every command.
    """
    if ask.commands and not all(
            any(
                pattern_matches(pat, split_pattern(spelling))
                for pat in ask.commands)
            for spelling in (commands or (WILDCARD, ))):
        return False
    return any(
        anchor_depth(path) > floor and hide_depth(classify_paths((
            path, )), entry) is not None for path in ask.paths)


def _curb_asks(asks: tuple[CommandRule, ...],
               other: AdmissionRules) -> tuple[CommandRule, ...]:
    """The other side's denies, restated at one side's ask entries.

    The composition the join owes: where one side asks and the other
    denies, the answer is the deny, since a deny is the stricter of
    the two. ``rule_at`` reads competing rules by anchor depth, deny
    before ask only at equal depth, so a deeper ask would outrank the
    shallower deny and turn the refusal into a prompt. Each such deny
    is restated at the ask's own depth, in the scope the two rules
    share (the commands and the mount both speak about), where the
    verb tie-break lets the refusal win; the ask itself stays whole,
    so outside that scope it still asks. A top-level ``cat`` ask
    meeting a deny written under one mount is refused inside that
    mount, an all-command ask meeting a ``cat`` deny is refused for
    ``cat`` and asked for the rest, and a ``git`` ask meeting a
    ``git push`` deny is refused for the push alone. Nothing is
    dropped, since dropping an entry would answer *allow* and lift the
    question its own side asked; and nothing is refused that the deny
    did not already refuse, since the restated rule reads a subset of
    its lines.

    A deny the other side's own deeper ask already outranks at that
    entry is not restated: that side's answer there was a question,
    not a refusal, so there is nothing to keep. That is what makes
    joining a rule set with itself a no-op, its carve-outs included.

    Args:
        asks (tuple[CommandRule, ...]): one side's ask rules.
        other (AdmissionRules): the other side's rules, whose denies
            are restated and whose asks may stand in the way.

    Returns:
        The deny rules to add, each carrying the reason of the deny it
        restates; empty when nothing would be lifted.
    """
    copies: list[CommandRule] = []
    for rule in asks:
        for entry in rule.paths:
            for deny in other.deny:
                commands = _shared_commands(rule.commands, deny.commands)
                mount = _shared_mount(rule.mount, deny.mount)
                if commands is None or mount is None:
                    continue
                floor = _reach_above(deny, entry)
                if floor is None or any(
                        _shields(ask, entry, floor, commands)
                        for ask in other.ask):
                    continue
                copy = CommandRule(reason=deny.reason,
                                   commands=commands,
                                   paths=(entry, ),
                                   mount=mount)
                if copy not in copies:
                    copies.append(copy)
    return tuple(copies)


def _merge_commands(base: AdmissionRules | None,
                    table: AdmissionRules | None) -> AdmissionRules | None:
    """Both rule sets as one: ask and deny rules union, the allow list
    intersects; the session's own object when the table adds nothing.

    The union is not a concatenation. Two rule sets read together are
    read by anchor depth, so an ask from one side can outrank a deny
    from the other and answer a refusal with a prompt; :func:`_curb_asks`
    restates each such deny at the ask's depth, in both directions, so
    a deny from either side stays a deny.

    Args:
        base (AdmissionRules | None): the session's rules.
        table (AdmissionRules | None): the stored table's rules.
    """
    if table is None:
        return base
    if base is None:
        return table
    deny = _append_rules(
        _append_rules(base.deny, table.deny),
        _append_rules(_curb_asks(base.ask, table), _curb_asks(table.ask,
                                                              base)))
    merged = AdmissionRules(allow=_merge_allow(base.allow, table.allow),
                            ask=_append_rules(base.ask, table.ask),
                            deny=deny)
    return base if merged == base else merged


def _cap_of(modes: dict[str, MountMode] | None, head: str) -> MountMode | None:
    """The per-mount cap in force at a path: the mode of the longest
    prefix covering it, None when none does.

    Args:
        modes (dict[str, MountMode] | None): one side's caps.
        head (str): the place a show entry anchors to.
    """
    best: tuple[int, MountMode] | None = None
    for prefix, mode in (modes or {}).items():
        root = _root_of(prefix)
        if root == "/" or head == root or head.startswith(root + "/"):
            depth = anchor_depth(root)
            if best is None or depth > best[0]:
                best = (depth, mode)
    return None if best is None else best[1]


@dataclass(frozen=True, slots=True)
class _Side:
    """One side of a show merge: its caps, its hides and its shows.

    Args:
        caps (dict[str, MountMode] | None): the per-mount modes.
        hidden (HiddenPaths | None): the hide entries.
        shown (ShownPaths | None): the show entries.
    """

    caps: dict[str, MountMode] | None
    hidden: HiddenPaths | None
    shown: ShownPaths | None


def _hides_anything(hidden: HiddenPaths | None) -> bool:
    """Whether a hide set names anything at all.

    Args:
        hidden (HiddenPaths | None): one side's hide entries.
    """
    return hidden is not None and bool(hidden.paths or hidden.patterns)


def _grants(side: _Side, path: str) -> bool:
    """Whether one side leaves a path the other side shows accessible.

    The question a one-sided show turns on, and it is asked of the
    *other* side, never of the merged hide set: a show exists to
    re-open what a hide covers, so the side that states it has a hide
    over it by construction, and testing the union would drop every
    show against its own hide.

    It is the composition law's own rule (:func:`path_visible` without
    its road clause, which only makes a hidden ancestor listable): the
    path is granted when no hide covers it, or when a show covers it
    more deeply than the deepest hide that does. Asking the shows and
    not only the hides is what keeps a *nested* carve-out: one side's
    ``show /vault/public`` grants the other side's narrower
    ``show /vault/public/docs``, and the narrower one is the
    intersection of the two grants.

    A pattern that anchors nothing (``*.key``, no separator) re-opens
    by name anywhere and no depth comparison bounds it, so it is
    granted only where the other side hides nothing at all.

    One stated limit, and it is the grammar's rather than this
    function's. An anchored pattern is asked the same question as a
    path, so the other side *covering* it grants it (``/vault/*``
    grants ``/vault/a/*``, since the coverage test walks the entry's
    own prefixes). Two patterns that merely *overlap* -- ``/vault/*``
    ``/public`` beside ``/vault/a/*`` -- have no single entry that
    names their common ground: ``*`` crosses separators here, as GNU
    ``find -path`` has it, so the overlap is a family of paths and not
    a subtree. Neither grants the other and both are dropped, which
    can hide a path both sides allow. That is the narrowing direction,
    which is the one to fail in; naming a wrong intersection would be
    the other.

    Args:
        side (_Side): the other side.
        path (str): the show entry's path.
    """
    if is_glob(path) and "/" not in path:
        return not _hides_anything(side.hidden)
    hide = hide_depth(side.hidden, path)
    if hide is None:
        return True
    show = show_depth(side.shown, path)
    return show is not None and show > hide


def _allowance(side: _Side, path: str) -> MountMode | None:
    """The mode one side allows below a path, None when it states none.

    A show scores deeper than a per-mount cap, so a show mode covering
    the path is the answer where there is one and the cap is the
    answer otherwise -- the same order :func:`path_mode` reads them in.

    Args:
        side (_Side): the side to ask.
        path (str): the show entry's path.
    """
    stated = shown_mode(side.shown, path)
    return stated[1] if stated is not None else _cap_of(side.caps, path)


def _merge_show(mine: ShowEntry, other: ShowEntry | None, my_side: _Side,
                other_side: _Side) -> ShowEntry | None:
    """One show entry as both sides allow it, or None to drop it.

    A show does two things. It re-opens what a hide covers, so an entry
    only one side states survives exactly where the other side grants
    that path (:func:`_grants`) -- which keeps a nested carve-out both
    sides reach and drops a broad one only one side reaches. And it
    states the mode below its anchor, so a mode only one side states is
    held under whatever the other side allows there
    (:func:`_allowance`, a show mode where there is one and the mount
    cap otherwise); two stated modes take the weaker; two list-form
    entries stay list-form, since the merged caps already hold the
    weaker mode below them. The entry itself is returned when nothing
    changed, so an identical table leaves the session's objects in
    place.

    Args:
        mine (ShowEntry): the entry on the side being walked.
        other (ShowEntry | None): the other side's entry at the same
            path, None when it states none.
        my_side (_Side): the side being walked.
        other_side (_Side): the other one.
    """
    if other is None:
        if not _grants(other_side, mine.path):
            return None
        if mine.mode is None:
            return mine
        mode = _held(mine.mode, _allowance(other_side, mine.path))
    elif mine.mode is not None and other.mode is not None:
        mode = weaker_mode(mine.mode, other.mode)
    elif mine.mode is not None:
        mode = _held(mine.mode, _allowance(other_side, mine.path))
    elif other.mode is not None:
        mode = _held(other.mode, _allowance(my_side, mine.path))
    else:
        return mine
    return mine if mode == mine.mode else ShowEntry(path=mine.path, mode=mode)


def _held(mode: MountMode, allowed: MountMode | None) -> MountMode:
    """A mode one side states, held under what the other side allows.

    Args:
        mode (MountMode): the stated mode.
        allowed (MountMode | None): the other side's allowance, None
            when it states none.
    """
    return mode if allowed is None else weaker_mode(mode, allowed)


def _merge_shown(base: _Side, table: _Side) -> ShownPaths | None:
    """Both sides' show entries as both allow them (:func:`_merge_show`),
    the session's first; the session's own object when nothing changed.

    Each side is walked against the *other* side whole -- its caps, its
    hides and its shows -- which is why the sides are passed rather
    than the merged hide set: a show is stated against a hide, so the
    union always covers it.

    Args:
        base (_Side): the session's side.
        table (_Side): the stored table's side.
    """
    if base.shown is None and table.shown is None:
        return None
    base_entries = _folded(base.shown)
    table_entries = _folded(table.shown)
    by_table = {entry.path: entry for entry in table_entries}
    by_base = {entry.path: entry for entry in base_entries}
    out: list[ShowEntry] = []
    for entry in base_entries:
        merged = _merge_show(entry, by_table.get(entry.path), base, table)
        if merged is not None:
            out.append(merged)
    for entry in table_entries:
        if entry.path in by_base:
            continue
        merged = _merge_show(entry, None, table, base)
        if merged is not None:
            out.append(merged)
    if base.shown is not None and tuple(out) == base.shown.entries:
        return base.shown
    return classify_shows(out)


def _folded(shown: ShownPaths | None) -> tuple[ShowEntry, ...]:
    """One side's show entries, one per path, at its weakest mode.

    A session table keeps every entry it was given, and two entries for
    one path do not mean the deeper mode: :func:`shown_mode` takes the
    weaker of two at a depth, failing toward refusal. Matching by path
    against the raw list would pair the other side against whichever
    spelling came last and restore an ``rwx`` the source never had, so
    each side is folded to what is actually in force before the two are
    compared. A list-form entry (no mode) states visibility only and
    answers no mode question, so a stated mode beside it stands.

    Args:
        shown (ShownPaths | None): one side's entries.
    """
    out: dict[str, ShowEntry] = {}
    for entry in (shown.entries if shown is not None else ()):
        held = out.get(entry.path)
        if held is None:
            out[entry.path] = entry
        elif entry.mode is not None:
            out[entry.path] = ShowEntry(
                path=entry.path,
                mode=entry.mode if held.mode is None else weaker_mode(
                    held.mode, entry.mode))
    return tuple(out.values())


def narrow_restored(session: Session, table: Session) -> None:
    """Land a stored session table on a session, never wider than either.

    The restore's counterpart of :func:`narrow`. A snapshot carries a
    session's narrowing as it stood in the source deployment; the
    session it lands on already runs under the target's document (the
    profile of the same name, or the live session's on a checkout). One
    rule joins the two: restrictions union, grants intersect, the
    program is the target's. Caps take the weaker mode per prefix,
    hides and hidden variables union, hide reasons and ask and deny
    rules append what the session lacks, the allow list is what both
    grant, a show survives only as both sides allow it
    (:func:`_merge_show`), and ``script`` and ``profile`` stay the
    session's, since a policy program is deployment code and the gate
    judged the table under the target's. Every field keeps the
    session's own object when the table adds nothing, so a table taken
    from the same document is the identity, and running this twice is
    running it once, which a checkout that lands live tables back on
    themselves relies on.

    Two consequences worth stating. On a running workspace a checkout
    can only add restrictions to a live session, never lift one: a hide
    from one version survives checking out another, and
    ``set_session_profile`` is the host's reset. And a show only one
    side states is dropped where the *other* side hides its anchor,
    mode and all, so a mode it restricted there reverts to the
    target's allowance; the show grammar has no spelling for a mode
    without a re-open. Its own side's hide never drops it: a show is
    always stated against a hide, so reading the union would erase
    every show exception the other side simply never mentioned.

    Args:
        session (Session): the session the table lands on, already
            narrowed under the target's document.
        table (Session): the stored table, as ``Session.from_dict``
            read it.
    """
    modes = _merge_modes(session.mount_modes, table.mount_modes)
    hidden = _merge_hidden_paths(session.hidden_paths, table.hidden_paths)
    shown = _merge_shown(
        _Side(session.mount_modes, session.hidden_paths, session.shown_paths),
        _Side(table.mount_modes, table.hidden_paths, table.shown_paths))
    session.hidden_vars = _merge_hidden_vars(session.hidden_vars,
                                             table.hidden_vars)
    session.hide_reasons = _merge_groups(session.hide_reasons,
                                         table.hide_reasons)
    session.commands = _merge_commands(session.commands, table.commands)
    session.mount_modes = modes
    session.hidden_paths = hidden
    session.shown_paths = shown

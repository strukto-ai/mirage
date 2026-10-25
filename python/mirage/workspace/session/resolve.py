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


from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from mirage.policy.errors import PolicyError
from mirage.policy.profile import (
    CommandsBlock,
    CompiledProfile,
    MountCommandsBlock,
    PathsBlock,
    ProfileMount,
    ProfilePolicies,
    ProfileSetup,
    SessionProfile,
    VarsBlock,
    compile_program,
)
from mirage.policy.types import (
    AdmissionRules,
    CommandRule,
    HideReason,
    ProfileScript,
    ProfileScripts,
)
from mirage.process.config import ProcessPermissions
from mirage.rs.errors import StreamRefusal
from mirage.rs.policy import (
    Wire,
    admission_matcher,
    from_units,
    rules_wire,
    units,
    visibility_from,
)
from mirage.types import MountMode, ShowEntry, weaker_mode
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.session import SessionState, vars_from_entries
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.validate import check_rules


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


def _paths_wire(block: PathsBlock | None) -> Wire | None:
    if block is None:
        return None
    return {
        "hide": [units(v) for v in block.hide],
        "show": [
            {
                "path": units(entry.path),
                "mode": None if entry.mode is None else entry.mode.value,
            }
            for entry in block.show
        ],
        "reasons": [
            {
                "patterns": [units(v) for v in group.patterns],
                "reason": units(group.reason),
            }
            for group in block.reasons
        ],
    }


def _profile_wire(profile: SessionProfile) -> Wire:
    block = profile.commands
    return {
        "commands": None
        if block is None
        else rules_wire(
            AdmissionRules(allow=block.allow, deny=block.deny, ask=block.ask)
        ),
        "paths": _paths_wire(profile.paths),
        "vars": None
        if profile.vars is None
        else [units(v) for v in profile.vars.hide],
        "mounts": None
        if profile.mounts is None
        else [
            {
                "prefix": units(prefix),
                "mode": None if entry.mode is None else entry.mode.value,
                "commands": None
                if entry.commands is None
                else rules_wire(
                    AdmissionRules(
                        deny=entry.commands.deny, ask=entry.commands.ask
                    )
                ),
                "paths": _paths_wire(entry.paths),
            }
            for prefix, entry in profile.mounts.items()
        ],
    }


def _rule_from(value: Mapping[str, Any]) -> CommandRule:
    return CommandRule(
        reason=from_units(value["reason"]),
        commands=tuple(from_units(v) for v in value["commands"]),
        paths=tuple(from_units(v) for v in value["paths"]),
        mount=from_units(value["mount"]) if value["mount"] is not None else "",
    )


def _rules_from(value: Mapping[str, Any] | None) -> AdmissionRules | None:
    if value is None:
        return None
    return AdmissionRules(
        allow=None
        if value["allow"] is None
        else tuple(from_units(v) for v in value["allow"]),
        deny=tuple(_rule_from(v) for v in value["deny"]),
        ask=tuple(_rule_from(v) for v in value["ask"]),
    )


def _reason_from(value: Mapping[str, Any]) -> HideReason:
    return HideReason(
        patterns=tuple(from_units(v) for v in value["patterns"]),
        reason=from_units(value["reason"]),
    )


def _paths_from(value: Mapping[str, Any] | None) -> PathsBlock | None:
    if value is None:
        return None
    return PathsBlock(
        hide=tuple(from_units(v) for v in value["hide"]),
        show=tuple(
            ShowEntry(
                path=from_units(entry["path"]),
                mode=None
                if entry["mode"] is None
                else MountMode(entry["mode"]),
            )
            for entry in value["show"]
        ),
        reasons=tuple(_reason_from(v) for v in value["reasons"]),
    )


def _profile_fields(
    value: Mapping[str, Any],
) -> tuple[
    CommandsBlock | None,
    PathsBlock | None,
    VarsBlock | None,
    dict[str, ProfileMount] | None,
]:
    rules = _rules_from(value["commands"])
    mounts = None
    if value["mounts"] is not None:
        mounts = {}
        for mount in value["mounts"]:
            mount_rules = _rules_from(mount["commands"])
            mounts[from_units(mount["prefix"])] = ProfileMount(
                mode=None
                if mount["mode"] is None
                else MountMode(mount["mode"]),
                commands=MountCommandsBlock(
                    deny=mount_rules.deny, ask=mount_rules.ask
                )
                if mount_rules is not None
                else None,
                paths=_paths_from(mount["paths"]),
            )
    return (
        CommandsBlock(allow=rules.allow, deny=rules.deny, ask=rules.ask)
        if rules is not None
        else None,
        _paths_from(value["paths"]),
        VarsBlock(hide=tuple(from_units(v) for v in value["vars"]))
        if value["vars"] is not None
        else None,
        mounts,
    )


def _restrict_matching(
    base: SessionProfile | None, inline: SessionProfile | None
) -> Mapping[str, Any] | None:
    try:
        restricted: Mapping[str, Any] | None = admission_matcher(None).ask(
            "restrict",
            base=_profile_wire(base) if base is not None else None,
            inline=_profile_wire(inline) if inline is not None else None,
        )
    except StreamRefusal as exc:
        raise PolicyError(exc.message) from exc
    return restricted


def _compile_plan(profile: SessionProfile) -> Mapping[str, Any]:
    plan: Mapping[str, Any] = admission_matcher(None).ask(
        "compile", profile=_profile_wire(profile)
    )
    return plan


def with_inline(
    base: SessionProfile | None, inline: SessionProfile | None
) -> SessionProfile | None:
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
    value = _restrict_matching(base, inline)
    if inline.command_limits is not None:
        raise PolicyError(
            "command_limits belong on the profile, not inline permissions"
        )
    if inline.policy is not None:
        raise PolicyError(
            "inline permissions may add ask and deny rules, "
            "not a policy; state one on the profile"
        )
    processes = (
        base.processes if base is not None else None
    ) or ProcessPermissions()
    if inline.processes is not None:
        processes = processes.restrict(inline.processes)
    if base is None:
        return (
            inline
            if inline.processes is None
            else inline.model_copy(update={"processes": processes})
        )
    assert value is not None
    commands, paths, variables, mounts = _profile_fields(value)
    env = (
        None
        if base.env is None and inline.env is None
        else {**(base.env or {}), **(inline.env or {})}
    )
    return SessionProfile(
        cwd=inline.cwd if inline.cwd is not None else base.cwd,
        env=env,
        commands=commands,
        paths=paths,
        vars=variables,
        mounts=mounts,
        policy=base.policy,
        command_limits=base.command_limits,
        processes=processes,
    )


def compile_commands(profile: SessionProfile) -> AdmissionRules | None:
    """A profile's admission rules: its own, plus every mount entry's,
    in one list; None when the profile states none.

    Mount rules come first so the entry closest to the data speaks
    first when several rules match at the same anchor depth and only
    the message differs.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    return _rules_from(_compile_plan(profile)["commands"])


def compile_scripts(effective: SessionProfile, name: str) -> ProfileScripts:
    """The profile's policy programs by method, compiled onto the
    session.

    Args:
        effective (SessionProfile): the resolved profile.
        name (str): the profile's name, empty for a document passed
            without one; what a program reads as ``ctx["profile"]``.

    Raises:
        PolicyError: a program is still a path, which means it reached
            the workspace without passing the config loader that loads
            one.
    """
    compiled: dict[str, tuple[ProfileScript, ...]] = {}
    for method, programs in (effective.policy or {}).items():
        entries: list[ProfileScript] = []
        for program in programs:
            try:
                entries.append(compile_program(program, name))
            except ValueError as exc:
                raise PolicyError(f"profile {name!r} {exc}") from exc
        if entries:
            compiled[method] = tuple(entries)
    return compiled


def compile_profile(
    effective: SessionProfile | None, name: str = ""
) -> CompiledProfile:
    """The session fields a profile compiles to.

    Args:
        effective (SessionProfile | None): the resolved profile with any
            inline document already added; None is an unrestricted
            session.
        name (str): the profile's name, empty for a document passed
            without one; carried onto its programs for ``ctx["profile"]``,
            for refusals to print, and onto the session as the group an
            owner-rendering command shows.
    """
    if effective is None:
        return CompiledProfile(profile=name or None)
    value = _compile_plan(effective)
    commands = _rules_from(value["commands"])
    check_rules(commands)
    processes = effective.processes or ProcessPermissions()
    return CompiledProfile(
        setup=ProfileSetup(
            env=dict(effective.env) if effective.env is not None else None,
            cwd=effective.cwd,
        ),
        visibility=visibility_from(value["visibility"], processes.list),
        policies=ProfilePolicies(
            mount_modes={
                from_units(prefix): MountMode(mode)
                for prefix, mode in value["mount_modes"]
            }
            or None,
            commands=commands,
            scripts=compile_scripts(effective, name),
            command_limits=effective.command_limits,
            processes=processes,
        ),
        hide_reasons=tuple(_reason_from(v) for v in value["hide_reasons"]),
        profile=name or None,
    )


def narrow(session: SessionState, compiled: CompiledProfile) -> None:
    """Stamp a compiled profile's narrowing onto a session.

    The fields no shell line can edit: the per-mount modes, hidden
    paths, show entries, hidden variables, hide reasons, the admission
    rules, the profile's policy, the profile's name. Applied at creation
    and again whenever a stored record could carry a stale copy (the
    default session after hydration), so the document, not the store,
    is what an agent runs under.

    Args:
        session (SessionState): the session to narrow.
        compiled (CompiledProfile): the effective profile.
    """
    policies = compiled.policies
    session.mount_modes = (
        dict(policies.mount_modes)
        if policies.mount_modes is not None
        else None
    )
    session.visibility = compiled.visibility
    session.hide_reasons = compiled.hide_reasons
    session.commands = policies.commands
    session.scripts = policies.scripts
    session.profile = compiled.profile
    session.command_limits = dict(policies.command_limits or {})
    session.processes = policies.processes


def narrowing_of(session: SessionState) -> CompiledProfile:
    """The narrowing a session holds, as the compiled profile ``narrow``
    stamps back unchanged: how a recorded session's restrictions land
    on another, the inline document and every later profile change kept.

    Args:
        session (SessionState): the session to read.
    """
    return CompiledProfile(
        visibility=session.visibility,
        policies=ProfilePolicies(
            mount_modes=session.mount_modes,
            commands=session.commands,
            scripts=session.scripts,
            command_limits=session.command_limits,
            processes=session.processes,
        ),
        hide_reasons=session.hide_reasons,
        profile=session.profile,
    )


def stricter_modes(
    a: Mapping[str, MountMode] | None, b: Mapping[str, MountMode] | None
) -> dict[str, MountMode] | None:
    """Two sets of per-mount caps held at once: every prefix either one
    caps, at the weaker mode, so the result is never wider than either.

    Args:
        a (Mapping[str, MountMode] | None): one session's caps, None
            for none.
        b (Mapping[str, MountMode] | None): the other session's caps.
    """
    if a is None or b is None:
        caps = a if b is None else b
        return None if caps is None else dict(caps)
    out = dict(a)
    for prefix, mode in b.items():
        held = out.get(prefix)
        out[prefix] = mode if held is None else weaker_mode(held, mode)
    return out


def apply_profile(session: SessionState, compiled: CompiledProfile) -> None:
    """Narrow a fresh session and seed its scratch state from the profile.

    A profile's env speaks the workspace ``env`` block's grammar, so a
    bare string is exported: seeding it plain left ``$TOKEN`` expanding
    while every command, CLI and guest runtime in the profiled session
    saw nothing, since all three read ``env_snapshot`` and that is the
    exported set. A managed entry lands as its pointer, fetched when a
    line names it. The cwd is where the session starts; both are the
    agent's to change afterwards, which is why hydration keeps the
    stored ones and re-stamps only :func:`narrow`.

    Args:
        session (SessionState): the session just created.
        compiled (CompiledProfile): the effective profile.
    """
    narrow(session, compiled)
    if compiled.setup.env:
        session.vars.update(vars_from_entries(compiled.setup.env))
    if compiled.setup.cwd is not None:
        set_cwd(session, compiled.setup.cwd)

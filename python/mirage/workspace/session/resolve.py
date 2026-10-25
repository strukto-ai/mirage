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
from typing import TYPE_CHECKING

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
from mirage.rs.policy import (
    MODES,
    PathsValue,
    ProfileValue,
    from_units,
    policy_compile,
    policy_restrict,
    rule_value,
    units,
    visibility_from_value,
)
from mirage.types import MountMode, ShowEntry, weaker_mode
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.session import SessionState, vars_from_entries
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.validate import check_rules

if TYPE_CHECKING:
    from mirage._rs import PolicyPaths, PolicyProfile, PolicyRule, PolicyRules


def resolve_profile(
    profiles: Mapping[str, SessionProfile],
    profile: str | SessionProfile | None,
) -> SessionProfile | None:
    if profile is None:
        return profiles.get(DEFAULT_PROFILE)
    if not isinstance(profile, str):
        return profile
    if profile not in profiles:
        raise PolicyError(f"unknown profile {profile!r}")
    return profiles[profile]


def _profile_value(profile: SessionProfile) -> ProfileValue:
    block = profile.commands
    commands = (
        (
            None
            if block.allow is None
            else tuple(units(v) for v in block.allow),
            tuple(rule_value(rule) for rule in block.deny),
            tuple(rule_value(rule) for rule in block.ask),
        )
        if block is not None
        else None
    )
    paths = _paths_value(profile.paths)
    mounts = (
        tuple(
            (
                units(prefix),
                MODES.index(entry.mode) if entry.mode is not None else None,
                (
                    None,
                    tuple(rule_value(rule) for rule in entry.commands.deny),
                    tuple(rule_value(rule) for rule in entry.commands.ask),
                )
                if entry.commands is not None
                else None,
                _paths_value(entry.paths),
            )
            for prefix, entry in profile.mounts.items()
        )
        if profile.mounts is not None
        else None
    )
    return (
        commands,
        paths,
        tuple(units(v) for v in profile.vars.hide)
        if profile.vars is not None
        else None,
        mounts,
    )


def _paths_value(block: PathsBlock | None) -> PathsValue | None:
    if block is None:
        return None
    return (
        tuple(units(v) for v in block.hide),
        tuple(
            (
                units(v.path),
                MODES.index(v.mode) if v.mode is not None else None,
            )
            for v in block.show
        ),
        tuple(
            (tuple(units(v) for v in group.patterns), units(group.reason))
            for group in block.reasons
        ),
    )


def _rule_from_value(value: PolicyRule) -> CommandRule:
    return CommandRule(
        reason=from_units(value[0]),
        commands=tuple(from_units(v) for v in value[1]),
        paths=tuple(from_units(v) for v in value[2]),
        mount=from_units(value[3]) if value[3] is not None else "",
    )


def _commands_from_value(value: PolicyRules | None) -> AdmissionRules | None:
    if value is None:
        return None
    return AdmissionRules(
        allow=None
        if value[0] is None
        else tuple(from_units(v) for v in value[0]),
        deny=tuple(_rule_from_value(v) for v in value[1]),
        ask=tuple(_rule_from_value(v) for v in value[2]),
    )


def _paths_from_value(value: PolicyPaths | None) -> PathsBlock | None:
    if value is None:
        return None
    return PathsBlock(
        hide=tuple(from_units(v) for v in value[0]),
        show=tuple(
            ShowEntry(
                path=from_units(v), mode=None if mode is None else MODES[mode]
            )
            for v, mode in value[1]
        ),
        reasons=tuple(
            HideReason(
                patterns=tuple(from_units(v) for v in patterns),
                reason=from_units(reason),
            )
            for patterns, reason in value[2]
        ),
    )


def _profile_fields(
    value: PolicyProfile,
) -> tuple[
    CommandsBlock | None,
    PathsBlock | None,
    VarsBlock | None,
    dict[str, ProfileMount] | None,
]:
    rules = _commands_from_value(value[0])
    mounts = None
    if value[3] is not None:
        mounts = {}
        for prefix, mode, commands, paths in value[3]:
            mount_rules = _commands_from_value(commands)
            mounts[from_units(prefix)] = ProfileMount(
                mode=None if mode is None else MODES[mode],
                commands=MountCommandsBlock(
                    deny=mount_rules.deny, ask=mount_rules.ask
                )
                if mount_rules is not None
                else None,
                paths=_paths_from_value(paths),
            )
    return (
        CommandsBlock(allow=rules.allow, deny=rules.deny, ask=rules.ask)
        if rules is not None
        else None,
        _paths_from_value(value[1]),
        VarsBlock(hide=tuple(from_units(v) for v in value[2]))
        if value[2] is not None
        else None,
        mounts,
    )


def _restrict_matching(
    base: SessionProfile | None, inline: SessionProfile | None
) -> PolicyProfile | None:
    try:
        return policy_restrict(
            _profile_value(base) if base is not None else None,
            _profile_value(inline) if inline is not None else None,
        )
    except ValueError as exc:
        raise PolicyError(str(exc)) from exc


def with_inline(
    base: SessionProfile | None, inline: SessionProfile | None
) -> SessionProfile | None:
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
    return _commands_from_value(policy_compile(_profile_value(profile))[0])


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
    value = policy_compile(_profile_value(effective))
    commands = _commands_from_value(value[0])
    check_rules(commands)
    processes = effective.processes or ProcessPermissions()
    return CompiledProfile(
        setup=ProfileSetup(
            env=dict(effective.env) if effective.env is not None else None,
            cwd=effective.cwd,
        ),
        visibility=visibility_from_value(value[1], processes.list),
        policies=ProfilePolicies(
            mount_modes={
                from_units(prefix): MODES[mode] for prefix, mode in value[2]
            }
            or None,
            commands=commands,
            scripts=compile_scripts(effective, name),
            command_limits=effective.command_limits,
            processes=processes,
        ),
        hide_reasons=tuple(
            HideReason(
                patterns=tuple(from_units(v) for v in patterns),
                reason=from_units(reason),
            )
            for patterns, reason in value[3]
        ),
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

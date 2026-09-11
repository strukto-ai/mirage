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

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from mirage.policy.constants import DEFAULT_ASK_REASON, DEFAULT_DENY_REASON
from mirage.policy.types import (AdmissionRules, CommandRule, HideReason,
                                 ProfileScript)
from mirage.runtime.types import ScriptSource
from mirage.types import (HiddenPaths, HiddenVars, MountMode, ShowEntry,
                          ShownPaths, parse_mount_mode)
from mirage.utils.hidden import is_glob

_DOC = ConfigDict(extra="forbid", frozen=True)

_RULE_FIELDS = frozenset({"reason", "commands", "paths"})


def _norm_prefix(prefix: str) -> str:
    """One spelling for a mount prefix: leading slash, no trailing one.

    Args:
        prefix (str): a prefix as typed in the document.
    """
    return "/" + prefix.strip("/")


def _list(value: Any, where: str, expected: str = "a list") -> tuple[Any, ...]:
    """A document list, refused before a scalar can be iterated.

    Args:
        value (Any): the field as written, None when absent.
        where (str): the field's name, for the message.
        expected (str): the expected shape named in the message.
    """
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{where} must be {expected}")
    return tuple(value)


def _string_list(value: Any,
                 where: str,
                 names: str | None = None) -> tuple[str, ...]:
    """A document list field, refused unless every item is a string.

    A scalar ``commands: rm`` would otherwise ``tuple()`` into
    ``('r', 'm')`` and the command it meant to refuse stay allowed, so
    the document fails to load instead, as it does in TypeScript. An
    entry that names something must also hold a token: a blank command
    pattern is a prefix of every line, so a stray ``""`` would allow,
    ask about or deny every command, and a blank path entry is the
    root, so it would hide or deny the whole tree.

    Args:
        value (Any): the field as written, None when absent.
        where (str): the field's name, for the message.
        names (str | None): what a non-blank entry names (``a
            command``, ``a path``); None accepts blank entries.
    """
    entries = _list(value, where, "a list of strings")
    for i, entry in enumerate(entries):
        if not isinstance(entry, str):
            raise ValueError(f"{where}[{i}] must be a string")
        if names is not None and not entry.split():
            raise ValueError(f"{where}[{i}] must name {names}")
    return entries


def _absolute_paths(entries: tuple[str, ...], where: str) -> None:
    """Refuse a relative path entry. Every path in the document is
    absolute.

    An entry is either an absolute path or a name pattern (``*.pem``,
    no slash, matching a path component anywhere). A plain ``xxx`` or
    an anchored ``secrets/*`` would otherwise be read from the root
    (``/xxx``, ``/secrets/*``), which is never what a relative spelling
    meant. There is no relative spelling anywhere: a mount section
    spells its paths in full and they are checked against the mount
    root (``_under_mount``), which is what a rebase used to do silently
    and wrongly (``/repo/secret`` under ``/repo`` became
    ``/repo/repo/secret``).

    Args:
        entries (tuple[str, ...]): the entries as written.
        where (str): the field's name, for the message.
    """
    for i, entry in enumerate(entries):
        if entry.startswith("/") or (is_glob(entry) and "/" not in entry):
            continue
        raise ValueError(f"{where}[{i}] must be an absolute path or a name "
                         f"pattern: {entry!r} is relative")


def _under_mount(entries: tuple[str, ...], root: str, where: str) -> None:
    """Refuse a path entry in a mount's section that leaves the mount.

    A mount's rules are about that mount, so a path under
    ``mounts./repo`` names something inside ``/repo``. A name pattern
    carries no anchor and is left alone; it means the same thing here
    as anywhere else.

    The root mount contains everything, and has to be spelled out:
    ``root + "/"`` is ``"//"`` there, which no path starts with, so a
    workspace mounted at ``/`` could write a section for its one mount
    and then name nothing inside it.

    Args:
        entries (tuple[str, ...]): the entries as written.
        root (str): the mount prefix, leading slash, no trailing one.
        where (str): the field's name, for the message.
    """
    if root == "/":
        return
    for i, entry in enumerate(entries):
        if not entry.startswith("/"):
            continue
        if entry == root or entry.startswith(root + "/"):
            continue
        raise ValueError(f"{where}[{i}] is outside the mount it is written "
                         f"under: {entry!r} is not below {root!r}")


def _scoped_rules(commands: Mapping[Any, Any], reason: str,
                  where: str) -> list[CommandRule]:
    """The rules of a ``commands`` mapping: each command on its own paths.

    One rule per entry, so the document never states a command beside
    a path it was not meant for: ``{rm: [/repo/*], mv: [/shared/*]}``
    scopes ``rm`` to the repo and ``mv`` to the share, nothing else.

    Args:
        commands (Mapping[Any, Any]): the mapping as written, command
            pattern to its path entries.
        reason (str): the rule's reason, shared by every entry.
        where (str): ``deny rule`` or ``ask rule``, for the messages.
    """
    if not commands:
        raise ValueError(f"{where} commands must name at least one command")
    rules = []
    for pattern, paths in commands.items():
        if not isinstance(pattern, str) or not pattern.split():
            raise ValueError(f"{where} commands keys must name a command")
        entries = _string_list(paths,
                               f"{where} commands[{pattern}]",
                               names="a path")
        if not entries:
            raise ValueError(
                f"{where} commands[{pattern}] must list at least one path")
        rules.append(
            CommandRule(reason=reason, commands=(pattern, ), paths=entries))
    return rules


def _rule(entry: Any, where: str, default_reason: str) -> list[CommandRule]:
    """Coerce one ``deny`` or ``ask`` entry to its CommandRules.

    A bare string is one command pattern over the whole line, with the
    verb's default reason. A mapping carries ``reason`` (defaulting) and
    exactly one of: ``commands`` as a list, a whole-line rule on each
    pattern; ``commands`` as a mapping, each command pattern on its own
    paths (one command to many paths, one rule per command); ``paths``
    alone, a path rule on every command. A list of commands beside a
    list of paths is refused, because it does not say which command the
    paths belong to, and a rule naming neither is refused rather than
    read as "every command".

    Args:
        entry (Any): one entry as written in the document.
        where (str): ``deny rule`` or ``ask rule``, for the messages.
        default_reason (str): the verb's reason for a rule stating
            none.
    """
    if isinstance(entry, CommandRule):
        # Already compiled: the resolver rebuilds blocks from rules, and
        # a typed caller may construct the document from them.
        return [entry]
    if isinstance(entry, str):
        return [
            CommandRule(reason=default_reason,
                        commands=_string_list((entry, ),
                                              f"{where} commands",
                                              names="a command"))
        ]
    if not isinstance(entry, Mapping):
        raise ValueError(f"{where} must be a command pattern or a mapping")
    unknown = sorted(set(entry) - _RULE_FIELDS)
    if unknown:
        raise ValueError(f"{where} has unknown field(s): {', '.join(unknown)}")
    reason = entry.get("reason", default_reason)
    if not isinstance(reason, str):
        raise ValueError(f"{where} reason must be a string")
    commands, paths = entry.get("commands"), entry.get("paths")
    if isinstance(commands, Mapping):
        if paths is not None:
            raise ValueError(f"{where} maps each command to its paths, "
                             "so it takes no paths of its own")
        return _scoped_rules(commands, reason, where)
    if commands is not None and paths is not None:
        raise ValueError(f"{where} lists commands beside paths; map each "
                         "command to its paths instead")
    if commands is None and paths is None:
        raise ValueError(f"{where} names no command and no path")
    return [
        CommandRule(reason=reason,
                    commands=_string_list(commands,
                                          f"{where} commands",
                                          names="a command"),
                    paths=_string_list(paths, f"{where} paths",
                                       names="a path"))
    ]


def _rules(v: Any, where: str) -> Any:
    default = DEFAULT_ASK_REASON if where == "ask" else DEFAULT_DENY_REASON
    return tuple(rule
                 for entry in _list(v, f"commands.{where}", "a list of rules")
                 for rule in _rule(entry, f"{where} rule", default))


def _patterns(v: Any) -> Any:
    if v is None:
        return None
    return _string_list(v, "commands.allow", names="a command")


class PathsBlock(BaseModel):
    """``paths:`` of a profile, or of one of its mount sections.

    ``hide`` entries use the document's one grammar: an entry with
    ``*``, ``?`` or ``[`` is a pattern, anything else an exact path
    and its subtree (``utils/hidden.classify_paths``); every entry
    holds a token and is absolute or a name pattern, wherever the block
    is written. A hide entry may also be a group
    ``{patterns: [...], reason: ...}``: the patterns join the flat list
    like any other entry and the reason lands in ``reasons``, the
    operator-only side table (:class:`HideReason`).

    ``show`` is the other half of the path axis: a mapping of path to
    mode (``{"/repo/docs": r}``), or a plain list whose entries inherit
    the mount's mode. Every entry is absolute, a subtree or an anchored
    pattern, because a show anchors to a place and a name pattern names
    none. An entry re-opens its subtree inside a hidden region when its
    anchor is deeper than the hide's, and states the mode in force
    below its anchor when it carries one; both on the one anchor-depth
    rule.

    Args:
        hide (tuple[str, ...]): what the profile makes nonexistent.
        show (tuple[ShowEntry, ...]): the profile's show entries, in
            document order.
        reasons (tuple[HideReason, ...]): why grouped hide entries
            exist, for the operator's doors only.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()
    show: tuple[ShowEntry, ...] = ()
    reasons: tuple[HideReason, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _v_groups(cls, data: Any) -> Any:
        # Reason groups are a spelling of `hide`, so they are split out
        # before the field validators read a flat list.
        if not isinstance(data, Mapping):
            return data
        raw = data.get("hide")
        if not isinstance(raw, (list, tuple)) or not any(
                isinstance(e, Mapping) for e in raw):
            return data
        flat: list[Any] = []
        groups: list[Any] = list(data.get("reasons") or ())
        for entry in raw:
            if not isinstance(entry, Mapping):
                flat.append(entry)
                continue
            unknown = sorted(set(entry) - {"patterns", "reason"})
            if unknown:
                raise ValueError("paths.hide group has unknown field(s): " +
                                 ", ".join(str(u) for u in unknown))
            patterns = _string_list(entry.get("patterns"),
                                    "paths.hide group patterns",
                                    names="a path")
            if not patterns:
                raise ValueError(
                    "paths.hide group must list at least one pattern")
            reason = entry.get("reason")
            if not isinstance(reason, str) or not reason.split():
                raise ValueError(
                    "paths.hide group reason must be a non-empty string")
            flat.extend(patterns)
            groups.append(HideReason(patterns=patterns, reason=reason))
        out = dict(data)
        out["hide"] = flat
        out["reasons"] = tuple(groups)
        return out

    @field_validator("hide", mode="before")
    @classmethod
    def _v_hide(cls, v: Any) -> Any:
        return _string_list(v, "paths.hide", names="a path")

    @field_validator("show", mode="before")
    @classmethod
    def _v_show(cls, v: Any) -> Any:
        if v is None:
            return ()
        if isinstance(v, Mapping):
            pairs = list(v.items())
        elif isinstance(v, (list, tuple)):
            pairs = []
            for entry in v:
                if isinstance(entry, ShowEntry):
                    pairs.append((entry.path, entry.mode))
                elif isinstance(entry, (list, tuple)) and len(entry) == 2:
                    pairs.append((entry[0], entry[1]))
                else:
                    pairs.append((entry, None))
        else:
            raise ValueError("paths.show must be a mapping of path to mode "
                             "or a list of paths")
        entries = []
        for path, mode in pairs:
            if not isinstance(path, str) or not path.split():
                raise ValueError("paths.show entries must name a path")
            if not path.startswith("/"):
                raise ValueError("paths.show entries anchor to a place, so "
                                 f"each is absolute: {path!r} is not")
            parsed: MountMode | None = None
            if mode is not None:
                if isinstance(mode, MountMode):
                    parsed = mode
                elif isinstance(mode, str):
                    parsed = parse_mount_mode(mode)
                else:
                    raise ValueError(
                        "paths.show modes must be a mode name or alias")
            entries.append(ShowEntry(path=path, mode=parsed))
        return tuple(entries)

    @field_validator("reasons", mode="before")
    @classmethod
    def _v_reasons(cls, v: Any) -> Any:
        entries = _list(v, "paths.reasons", "a list of groups")
        out = []
        for entry in entries:
            if isinstance(entry, HideReason):
                out.append(entry)
                continue
            if not isinstance(entry, Mapping):
                raise ValueError("paths.reasons entries must be groups of "
                                 "patterns and a reason")
            out.append(
                HideReason(patterns=_string_list(entry.get("patterns"),
                                                 "paths.reasons patterns",
                                                 names="a path"),
                           reason=str(entry.get("reason", ""))))
        return tuple(out)


class VarsBlock(BaseModel):
    """``vars:`` of a profile.

    Args:
        hide (tuple[str, ...]): variable names or globs over names the
            session reads as unset.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()


class CommandsBlock(BaseModel):
    """``commands:`` at the top level of a profile.

    ``allow`` lists the command patterns the profile installs; a name none
    of them starts with is not a command for the session (127, absent
    from ``type`` / ``which`` / ``man``), a line no pattern covers is
    refused. Shell builtins are subjects like everything else: a list
    stating only ``cat`` leaves no ``echo`` and no ``cd``. The agent's
    own functions are the one exemption, safe because every line of a
    body passes the gate itself. ``ask`` rules are admitted only with a
    host approval; ``deny`` rules refuse with a reason. A bare string in
    either is one command pattern with the default reason.

    Args:
        allow (tuple[str, ...] | None): the profile's allow patterns;
            None (unstated) installs everything.
        ask (tuple[CommandRule, ...]): what needs sign-off, in order.
        deny (tuple[CommandRule, ...]): the profile's refusals, in order.
    """

    model_config = _DOC

    allow: tuple[str, ...] | None = None
    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()

    @field_validator("allow", mode="before")
    @classmethod
    def _v_allow(cls, v: Any) -> Any:
        return _patterns(v)

    @field_validator("ask", mode="before")
    @classmethod
    def _v_ask(cls, v: Any) -> Any:
        return _rules(v, "ask")

    @field_validator("deny", mode="before")
    @classmethod
    def _v_deny(cls, v: Any) -> Any:
        return _rules(v, "deny")

    @model_validator(mode="after")
    def _v_absolute(self) -> "CommandsBlock":
        # This block is the profile's own, never a mount section's, so a
        # rule's paths are virtual paths: absolute, or name patterns.
        for verb, rules in (("ask", self.ask), ("deny", self.deny)):
            for rule in rules:
                _absolute_paths(rule.paths, f"{verb} rule paths")
        return self


class MountCommandsBlock(BaseModel):
    """``commands:`` of one mount section: ``ask`` and ``deny`` only.

    A mount rule applies to a line that works inside the mount (its cwd
    or one of its paths lies under the root); its ``paths`` are
    absolute, like every other path in the document, and must name
    something under that root. There is no ``allow`` here: what a
    session can see is a property of the session, and an operand cannot
    make a command "not found".

    Args:
        ask (tuple[CommandRule, ...]): what needs sign-off here.
        deny (tuple[CommandRule, ...]): what is refused here.
    """

    model_config = _DOC

    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()

    @field_validator("ask", mode="before")
    @classmethod
    def _v_ask(cls, v: Any) -> Any:
        return _rules(v, "ask")

    @field_validator("deny", mode="before")
    @classmethod
    def _v_deny(cls, v: Any) -> Any:
        return _rules(v, "deny")


class ProfileMount(BaseModel):
    """One mount's entry in a profile: what this profile may do there.

    Every field is optional, and an omitted mount is not a refusal: the
    mount is reachable at the mode it declares in the workspace's
    ``mounts:``, which a profile can only weaken (``weaker_mode``), never
    raise. A profile that must not touch a mount hides it, so the mount
    reads as nonexistent rather than as a permission error naming
    something the profile cannot see.

    ``commands`` here carries ask and deny only: an allow list installs
    a command for the whole session, and visibility is answered before
    any operand exists, so it cannot be per mount. Rules written here
    apply to a line that works inside this mount, by cwd or by operand,
    which is what a path-scoped rule cannot express (``cd /repo && git
    commit`` names no path).

    Args:
        mode (MountMode | None): this profile's mode for the mount; None
            keeps the mount's own.
        commands (MountCommandsBlock | None): ask and deny rules for
            lines working inside it.
        paths (PathsBlock | None): hides under it.
    """

    model_config = _DOC

    mode: MountMode | None = None
    commands: MountCommandsBlock | None = None
    paths: PathsBlock | None = None

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v: Any) -> Any:
        if v is None or isinstance(v, MountMode):
            return v
        if not isinstance(v, str):
            raise ValueError("mount mode must be a mode name or alias")
        return parse_mount_mode(v)


class ProfilePolicy(BaseModel):
    """A profile's policy as the document states it: the program, and
    the engine that runs it. A block, not a path: with no default engine
    a path alone would name a program nothing could run.

    Args:
        script (ScriptSource | str): the policy program. A ``str`` is
            the path form the config door accepts and loads; code
            passes the loaded ``ScriptSource``, so a path still spelled
            as a string when the workspace reads it means the config
            layer never saw it, and is refused there.
        runtime (str): the engine the program runs on. Required: there
            is no default engine, because an engine the operator never
            chose should not be the one their policy runs on.
    """

    model_config = _DOC

    script: ScriptSource | str
    runtime: str


class SessionProfile(BaseModel):
    """One profile: the whole permission document a session runs under.

    A session is created from exactly one of these, and it is the only
    place permissions are written. There is no workspace-wide block and
    no mount-owned block above it, so reading this object is reading
    everything the profile may do; what a profile does not say, it does not
    restrict. Configuration, not enforcement: the resolver compiles it
    onto the session's narrowing fields and the doors keep enforcing.
    Deliberately not named a View, which per the view convention is a
    door-scoped handle an agent holds, while a profile is what the
    embedder uses to *define* one. Frozen so two agents with the same
    profile share one object and neither can bend the other's view.

    Two rules decide a line against it, and they are the whole law.
    A rule naming no path is read by verb (deny before ask before
    allow), wherever it is written. A rule carrying paths, and every
    hide, is read by anchor depth: the deeper entry wins, ties break by
    verb.

    A profile may also state a ``policy``: a program defining the
    admission hooks it answers at, the way a coded Policy overrides only
    the hooks it cares about: ``pre_command(ctx)`` per command,
    ``pre_ops(ctx)`` per VFS op, ``pre_session(ctx)`` per env write
    (``preCommand``, ``preOps``, ``preSession`` in JavaScript). Each is
    handed the door's facts as ``ctx`` and answers with ``return``:
    allow (no opinion), deny, or at the command gate ask, so it
    expresses the conditions a declarative rule cannot; like every
    policy, it can only restrict, never grant past a deny. A block
    naming the program and the engine it runs on (``ProfilePolicy``),
    the shape a ``clis`` entry has. The document is optional beside it:
    a profile stating only a policy hides nothing, and the policy is its
    whole admission policy.

    Args:
        cwd (str | None): the session's working directory at creation.
        env (dict[str, str] | None): a process environment seeded and
            exported into the session at creation.
        mounts (dict[str, ProfileMount] | None): per-mount settings,
            keyed by prefix: a mode, ask and deny rules for lines
            working inside the mount, and hides under it. A mount the
            mapping omits keeps its own mode and gains no rules.
        paths (PathsBlock | None): the profile's hides, absolute.
        vars (VarsBlock | None): the profile's hidden variables.
        commands (CommandsBlock | None): the profile's allow list and its
            ask / deny rules, absolute paths.
        policy (ProfilePolicy | None): the profile's policy: its program
            and the engine that runs it.
    """

    model_config = _DOC

    cwd: str | None = None
    env: dict[str, str] | None = None
    mounts: dict[str, ProfileMount] | None = None
    paths: PathsBlock | None = None
    vars: VarsBlock | None = None
    commands: CommandsBlock | None = None
    policy: ProfilePolicy | None = None

    @model_validator(mode="before")
    @classmethod
    def _v_script_is_policy(cls, data: Any) -> Any:
        # The keys this was first shipped under, a `script` named for
        # what the file is rather than what it does and a `runtime`
        # beside it that read as the profile's own; refused with the new
        # spelling rather than as two more unknown keys.
        if isinstance(data, dict) and ("script" in data or "runtime" in data):
            raise ValueError(
                "script and runtime are now one policy block, policy: "
                "{script: <file>, runtime: <engine>}; its program defines "
                "pre_command(ctx) and answers with return")
        return data

    @field_validator("mounts", mode="before")
    @classmethod
    def _v_mounts(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, Mapping):
            # A bare list used to mean "only these mounts", and now
            # means nothing at all, so it fails loudly rather than
            # quietly dropping the confinement it used to carry.
            raise ValueError(
                "mounts must be a mapping of prefix to its settings")
        entries: dict[str, Any] = {}
        for prefix, entry in v.items():
            if not isinstance(prefix, str):
                raise ValueError("mounts keys must be strings")
            entries[_norm_prefix(prefix)] = ({
                "mode": entry
            } if isinstance(entry, str) else entry)
        return entries

    @model_validator(mode="after")
    def _v_absolute(self) -> "SessionProfile":
        # `commands` checks its own rule paths (CommandsBlock), so only
        # the hides and the mount sections are left to this one.
        if self.paths is not None:
            _absolute_paths(self.paths.hide, "paths.hide")
        for prefix, entry in (self.mounts or {}).items():
            where = f"mounts[{prefix}]"
            if entry.paths is not None:
                _absolute_paths(entry.paths.hide, f"{where}.paths.hide")
                _under_mount(entry.paths.hide, prefix, f"{where}.paths.hide")
                _under_mount(tuple(e.path for e in entry.paths.show), prefix,
                             f"{where}.paths.show")
            if entry.commands is not None:
                for verb, rules in (("ask", entry.commands.ask),
                                    ("deny", entry.commands.deny)):
                    for rule in rules:
                        _absolute_paths(rule.paths, f"{where}.commands.{verb}")
                        _under_mount(rule.paths, prefix,
                                     f"{where}.commands.{verb}")
        return self


@dataclass(frozen=True, slots=True)
class CompiledProfile:
    """The session fields an effective profile compiles to.

    Args:
        mount_modes (dict[str, MountMode] | None): the mode each mount
            section states; a mount absent from the map keeps its own.
        hidden_paths (HiddenPaths | None): every path the profile hides.
        hidden_vars (HiddenVars | None): the profile's hidden variables.
        env (dict[str, str] | None): variables to seed and export.
        cwd (str | None): the working directory to start in.
        commands (AdmissionRules | None): the profile's admission rules,
            its own and its mount sections' in one list.
        script (ProfileScript | None): the profile's policy program,
            which ``ScriptPolicy`` calls at the admission gate.
        shown_paths (ShownPaths | None): every show entry the profile
            states, its own and its mount sections' in one list.
        hide_reasons (tuple[HideReason, ...]): the operator's reasons
            for grouped hides, never rendered to the agent.
        profile (str | None): the profile's name, None for a document
            passed without one; what the session reports as its group.
    """

    mount_modes: dict[str, MountMode] | None
    hidden_paths: HiddenPaths | None
    hidden_vars: HiddenVars | None
    env: dict[str, str] | None
    cwd: str | None
    commands: AdmissionRules | None = None
    script: ProfileScript | None = None
    shown_paths: ShownPaths | None = None
    hide_reasons: tuple[HideReason, ...] = ()
    profile: str | None = None

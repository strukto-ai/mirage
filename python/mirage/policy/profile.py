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
from dataclasses import dataclass, field
from typing import Any, TypeAlias

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from mirage.execution.process.config import (
    DEFAULT_PROCESS_PERMISSIONS,
    ProcessPermissions,
)
from mirage.io.network import (
    NetworkRule,
    NetworkSetting,
    network_layer,
    network_routes,
)
from mirage.policy.builtin.output_cap import (
    check_command_limits,
    command_limits_to_json,
)
from mirage.policy.constants import (
    CTX_ENV,
    METHODS,
    PROGRAM_RUNTIME,
)
from mirage.policy.errors import PolicyError
from mirage.policy.types import (
    AdmissionRules,
    CommandNode,
    HideReason,
    OptionRule,
    Outcome,
    ProfileScript,
    ProfileScripts,
    RuleLeaf,
    ScriptMethod,
    ValueRule,
)
from mirage.rs.document import validate_document
from mirage.runtime.types import ScriptSource
from mirage.secrets.config import EnvVar, SecretRef
from mirage.types import (
    DEFAULT_VISIBILITY,
    Limit,
    MountMode,
    ShowEntry,
    Visibility,
    parse_mount_mode,
    weaker_mode,
)
from mirage.utils.hidden import is_glob
from mirage.utils.path import norm

_DOC = ConfigDict(extra="forbid", frozen=True)


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
    validate_document("under", entries, where, root=root)


def _read_leaf(raw: Mapping[str, Any] | None) -> RuleLeaf | None:
    if raw is None:
        return None
    return RuleLeaf(decision=Outcome(raw["decision"]), reason=raw["reason"])


def _read_option(raw: Mapping[str, Any]) -> OptionRule:
    return OptionRule(
        decision=_read_leaf(raw["decision"]),
        values={
            word: ValueRule(
                decision=_read_leaf(rule["decision"]),
                options={
                    name: _read_option(option)
                    for name, option in rule["options"].items()
                },
            )
            for word, rule in raw["values"].items()
        },
        options={
            name: _read_option(option)
            for name, option in raw["options"].items()
        },
    )


def _read_node(raw: Mapping[str, Any]) -> CommandNode:
    return CommandNode(
        decision=_read_leaf(raw["decision"]),
        subcommands={
            name: _read_node(node) for name, node in raw["subcommands"].items()
        },
        options={
            name: _read_option(option)
            for name, option in raw["options"].items()
        },
        other_options=_read_leaf(raw["other_options"]),
        operands={
            word: _read_node(node) for word, node in raw["operands"].items()
        },
    )


def command_tree(raw: Any, where: str = "commands") -> CommandNode:
    """A ``commands`` block read into its tree, by mirage-rs's shape
    check.

    Names are taken as written; checking them against the commands'
    grammars needs the workspace. A block in the old flat format (allow,
    ask and deny lists) is refused with a message naming the new one.

    Args:
        raw (Any): the block as written, or a tree already read.
        where (str): the block's name, for the messages.

    Raises:
        ValueError: the block is not a command tree.
    """
    if isinstance(raw, CommandNode):
        return raw
    return _read_node(validate_document("tree", raw, where))


def _leaf_doc(leaf: RuleLeaf) -> Any:
    if not leaf.reason:
        return leaf.decision.value
    return {"decision": leaf.decision.value, "reason": leaf.reason}


def _value_doc(rule: ValueRule) -> Any:
    if rule.decision and not rule.options:
        return _leaf_doc(rule.decision)
    doc: dict[str, Any] = {}
    if rule.decision:
        doc["*"] = _leaf_doc(rule.decision)
    doc.update(
        {name: _option_doc(option) for name, option in rule.options.items()}
    )
    return doc


def _option_doc(rule: OptionRule) -> Any:
    if rule.decision and not rule.values and not rule.options:
        return _leaf_doc(rule.decision)
    doc: dict[str, Any] = {}
    if rule.decision:
        doc["*"] = _leaf_doc(rule.decision)
    if rule.values:
        doc["values"] = {
            word: _value_doc(value) for word, value in rule.values.items()
        }
    doc.update(
        {name: _option_doc(option) for name, option in rule.options.items()}
    )
    return doc


def _node_doc(node: CommandNode) -> Any:
    if node.decision and not (
        node.subcommands or node.options or node.other_options or node.operands
    ):
        return _leaf_doc(node.decision)
    return tree_doc(node)


def tree_doc(tree: CommandNode) -> dict[str, Any]:
    """A command tree as the ``commands`` block that reads back to it,
    each place in its shortest spelling.

    Args:
        tree (CommandNode): the tree, or one node of it.
    """
    doc: dict[str, Any] = {}
    if tree.decision:
        doc["*"] = _leaf_doc(tree.decision)
    if tree.other_options:
        doc["-*"] = _leaf_doc(tree.other_options)
    doc.update(
        {name: _option_doc(option) for name, option in tree.options.items()}
    )
    doc.update(
        {name: _node_doc(node) for name, node in tree.subcommands.items()}
    )
    if tree.operands:
        doc["operands"] = {
            word: _node_doc(node) for word, node in tree.operands.items()
        }
    return doc


def _paths(raw: Any, where: str) -> dict[str, Any]:
    """A ``paths:`` block's fields, checked by mirage-rs's rule.

    Reason groups are a spelling of ``hide``: their patterns join the
    flat list and their reasons land in ``reasons``. Every hide entry is
    absolute or a name pattern, every show entry absolute. A typed
    caller's compiled entries (``ShowEntry``, ``HideReason``) are checked
    as the document spells them and kept as given.

    Args:
        raw (Any): the block as written.
        where (str): the block's name, for the messages.
    """
    show: Any = raw.get("show") if isinstance(raw, Mapping) else None
    typed = isinstance(show, (list, tuple)) and any(
        isinstance(entry, ShowEntry) for entry in show
    )
    doc = raw
    if isinstance(raw, Mapping):
        doc = dict(raw)
        if typed:
            doc["show"] = [
                entry.path if isinstance(entry, ShowEntry) else entry
                for entry in show
            ]
        if isinstance(raw.get("reasons"), (list, tuple)):
            doc["reasons"] = [
                {"patterns": list(group.patterns), "reason": group.reason}
                if isinstance(group, HideReason)
                else group
                for group in raw["reasons"]
            ]
    parsed = validate_document("paths", doc, where)
    shown = [
        ShowEntry(
            path=entry["path"],
            mode=None if entry["mode"] is None else MountMode(entry["mode"]),
        )
        for entry in parsed.get("show", ())
    ]
    if typed:
        shown = [
            given if isinstance(given, ShowEntry) else entry
            for given, entry in zip(show, shown, strict=True)
        ]
    return {
        "hide": tuple(parsed["hide"]),
        "show": tuple(shown),
        "reasons": tuple(
            HideReason(
                patterns=tuple(group["patterns"]), reason=group["reason"]
            )
            for group in parsed.get("reasons", ())
        ),
    }


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
            exist, for the operator's entry points only.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()
    show: tuple[ShowEntry, ...] = ()
    reasons: tuple[HideReason, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _v_document(cls, data: Any) -> Any:
        if not isinstance(data, Mapping):
            return data
        return _paths(data, "paths")


class VarsBlock(BaseModel):
    """``vars:`` of a profile.

    Args:
        hide (tuple[str, ...]): variable names or globs over names the
            session reads as unset.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()


class ProfileMount(BaseModel):
    """One mount's entry in a profile: what this profile may do there.

    Every field is optional, and an omitted mount is not a refusal: the
    mount is reachable at the mode it declares in the workspace's
    ``mounts:``, which a profile can only weaken (``weaker_mode``), never
    raise. A profile that must not touch a mount hides it, so the mount
    reads as nonexistent rather than as a permission error naming
    something the profile cannot see.

    ``commands`` here is a command tree of its own. It applies to a line
    that works inside this mount or folder, by cwd or by a path it names
    (``cd /repo && git commit`` names no path and still works in
    ``/repo``). It is judged beside the top-level tree and the strictest
    result wins, so it only tightens.

    Args:
        mode (MountMode | None): this profile's mode for the mount; None
            keeps the mount's own.
        commands (CommandNode | None): the tree for lines working
            inside it.
        paths (PathsBlock | None): hides under it.
    """

    model_config = _DOC

    mode: MountMode | None = None
    commands: CommandNode | None = None
    paths: PathsBlock | None = None

    @field_validator("commands", mode="before")
    @classmethod
    def _v_commands(cls, v: Any) -> Any:
        return None if v is None else command_tree(v)

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v: Any) -> Any:
        if v is None or isinstance(v, MountMode):
            return v
        if not isinstance(v, str):
            raise ValueError("mount mode must be a mode name or alias")
        return parse_mount_mode(v)


class ProfilePolicy(BaseModel):
    """One program of a profile's policy, as the document states it: the
    program, and the runtime that runs it.

    Args:
        script (ScriptSource | str): the policy program. A ``str`` is
            the path form the config loader accepts and loads; code
            passes the loaded ``ScriptSource``, so a path still spelled
            as a string when the workspace reads it means the config
            layer never saw it, and is refused there.
        runtime (str | dict[str, Any]): the runtime the program runs on:
            a name, or ``{name, config}`` for one that needs settings.
            Monty when the program
            names none; without the ``monty`` extra installed, such a
            program fails closed with the extra's install hint.
        env (dict[str, str | SecretRef]): variables the program runs
            with beside ``MIRAGE_POLICY_CTX``, on any runtime: a literal,
            or a pointer read from its source when the program first
            runs. None of the session's reach it.
    """

    model_config = _DOC

    script: ScriptSource | str
    runtime: str | dict[str, Any] = PROGRAM_RUNTIME
    env: dict[str, str | SecretRef] = {}

    @field_validator("env")
    @classmethod
    def _v_env(
        cls, v: dict[str, str | SecretRef]
    ) -> dict[str, str | SecretRef]:
        if CTX_ENV in v:
            raise ValueError(
                f"a policy program's env cannot set {CTX_ENV}, which "
                f"carries its context"
            )
        return v

    @field_validator("runtime")
    @classmethod
    def _v_runtime(cls, v: str | dict[str, Any]) -> str | dict[str, Any]:
        if isinstance(v, str):
            return v
        unknown = sorted(set(v) - {"name", "config"})
        if unknown or not isinstance(v.get("name"), str):
            raise ValueError(
                f"a policy runtime is a name or {{name, config}}, got {v!r}"
            )
        if not isinstance(v.get("config", {}), dict):
            raise ValueError("a policy runtime's config is a mapping")
        return v


ProfilePrograms: TypeAlias = dict[ScriptMethod, list[ProfilePolicy]]


def parse_program(raw: Any) -> ProfilePolicy:
    return ProfilePolicy.model_validate(raw)


def compile_program(program: ProfilePolicy, profile: str) -> ProfileScript:
    """A policy program as it runs: its source, its runtime's name and
    that runtime's settings.

    Args:
        program (ProfilePolicy): the program as the document states it.
        profile (str): the profile it speaks for, empty for the
            workspace's ``route_policy``.

    Raises:
        ValueError: the script is still a path, which only the config
            loader loads.
    """
    if isinstance(program.script, str):
        raise ValueError(
            f"names a policy by path ({program.script!r}); only the "
            f"config loader loads one, pass ScriptSource in code"
        )
    named: dict[str, Any] = (
        {"name": program.runtime}
        if isinstance(program.runtime, str)
        else program.runtime
    )
    return ProfileScript(
        profile=profile,
        script=program.script,
        runtime=named["name"],
        config=dict(named.get("config") or {}),
        env=dict(program.env),
    )


def parse_profile_policy(v: Any) -> Any:
    if v is None:
        return None
    if not isinstance(v, Mapping):
        raise ValueError("policy must be a mapping of method to programs")
    unknown = sorted(str(k) for k in v if k not in METHODS)
    if unknown:
        raise ValueError(
            f"policy names {', '.join(unknown)}; a program answers at "
            f"{', '.join(METHODS)}"
        )
    return v


def parse_profile_mounts(v: Any) -> Any:
    if v is None:
        return None
    if not isinstance(v, Mapping):
        # A bare list used to mean "only these mounts", and now
        # means nothing at all, so it fails loudly rather than
        # quietly dropping the confinement it used to carry.
        raise ValueError("mounts must be a mapping of prefix to its settings")
    entries: dict[str, Any] = {}
    for prefix, entry in v.items():
        if not isinstance(prefix, str):
            raise ValueError("mounts keys must be strings")
        root = norm(prefix)
        if is_glob(root):
            raise ValueError(
                f"mounts[{root}]: a key is a literal path, not a glob; "
                "write one key per folder"
            )
        if isinstance(entry, str):
            entry = {"mode": entry}
        elif isinstance(entry, Mapping):
            entry = {**entry}
            if isinstance(entry.get("paths"), Mapping):
                entry["paths"] = _paths(
                    entry["paths"], f"mounts[{root}].paths"
                )
            if entry.get("commands") is not None:
                entry["commands"] = command_tree(
                    entry["commands"], f"mounts[{root}].commands"
                )
        entries[root] = entry
    return entries


class SessionProfile(BaseModel):
    """One profile: the whole permission document a session runs under.

    A session is created from exactly one of these, and it is the only
    place permissions are written. There is no workspace-wide block and
    no mount-owned block above it, so reading this object is reading
    everything the profile may do; what a profile does not say, it does not
    restrict. Configuration, not enforcement: the resolver compiles it
    onto the session's narrowing fields and the entry points keep enforcing.
    Deliberately not named a View, which per the view convention is a
    handle an agent holds on one entry point, while a profile is what the
    embedder uses to *define* one. Frozen so two agents with the same
    profile share one object and neither can bend the other's view.

    Two rules decide a line against it, and they are the whole law.
    A command rule is read by verb (deny before ask before allow),
    wherever it is written; a rule for one folder is written in that
    folder's ``mounts`` entry. A hide is read by anchor depth: the
    deeper entry wins, ties break by verb.

    A profile may also state a ``policy``: for each method it answers at
    (``pre_execute``, ``pre_command``, ``pre_vfs``, ``pre_network`` and
    their ``post_`` twins), a list of programs, each with the runtime it runs
    on (``ProfilePolicy``, the shape a ``clis`` entry has). A program's
    function for the method takes its context and returns its answer:
    None for no opinion, a deny, an ask, or at ``pre_execute`` a route.
    They are asked in order and the first deny wins, so a policy expresses
    the conditions a declarative rule cannot; like every policy, it can
    only restrict, never grant past a deny. The document is optional
    beside it: a profile stating only a policy hides nothing, and the
    policy is its whole admission policy.

    Args:
        cwd (str | None): the session's working directory at creation.
        env (dict[str, str | EnvVar] | None): the env entries seeded
            into the session at creation, in the workspace ``env``
            grammar: a bare string is an exported literal, and a
            ``from:`` entry a managed pointer, so a credential is
            named here and fetched, never written as its value.
        mounts (dict[str, ProfileMount] | None): per-mount settings,
            keyed by prefix: a mode, a command tree for lines working
            inside the mount, and hides under it. A mount the mapping
            omits keeps its own mode and gains no rules.
        paths (PathsBlock | None): the profile's hides, absolute.
        vars (VarsBlock | None): the profile's hidden variables.
        commands (CommandNode | None): the profile's command tree.
        policy (dict[ScriptMethod, list[ProfilePolicy]] | None): the
            profile's policy: each ``pre_`` method's programs, asked in
            order.
        network (bool | dict[str, list[str]] | None): where the
            session's lines may connect, the workspace's ``network``
            grammar, held besides the workspace's own; None leaves the
            workspace's alone.
    """

    model_config = _DOC

    cwd: str | None = None
    env: dict[str, str | EnvVar] | None = None
    mounts: dict[str, ProfileMount] | None = None
    paths: PathsBlock | None = None
    vars: VarsBlock | None = None
    commands: CommandNode | None = None
    policy: ProfilePrograms | None = None
    command_limits: dict[str, Limit] | None = None
    processes: ProcessPermissions | None = None
    network: bool | dict[str, list[str] | dict[str, str]] | None = None

    @field_validator("network", mode="before")
    @classmethod
    def _v_network(cls, v: Any) -> NetworkSetting | None:
        if v is None:
            return v
        layer = network_layer(v)
        NetworkRule(
            [layer] if layer is not None else [], False, network_routes(v)
        )
        return (
            bool(v)
            if isinstance(v, bool)
            else {
                key: dict(value) if key == "routes" else list(value)
                for key, value in v.items()
            }
        )

    @field_validator("command_limits")
    @classmethod
    def _v_command_limits(
        cls, v: dict[str, Limit] | None
    ) -> dict[str, Limit] | None:
        if v is not None:
            check_command_limits(v, "profile", takes_line=True)
        return v

    _v_policy = field_validator("policy", mode="before")(parse_profile_policy)

    @field_validator("commands", mode="before")
    @classmethod
    def _v_commands(cls, v: Any) -> Any:
        return None if v is None else command_tree(v)

    _v_mounts = field_validator("mounts", mode="before")(parse_profile_mounts)

    @model_validator(mode="after")
    def _v_entry_paths_under_mount(self) -> "SessionProfile":
        """Refuse a folder entry's ``paths.hide`` or ``paths.show`` entry
        that lies outside the entry's own folder."""
        for prefix, entry in (self.mounts or {}).items():
            if entry.paths is not None:
                where = f"mounts[{prefix}]"
                _under_mount(entry.paths.hide, prefix, f"{where}.paths.hide")
                _under_mount(
                    tuple(e.path for e in entry.paths.show),
                    prefix,
                    f"{where}.paths.show",
                )
        return self


def check_mount_modes(profile: SessionProfile, mounts: Iterable[str]) -> None:
    """Refuse a ``mode`` on a ``mounts`` key that is a folder inside a
    mount.

    A mode caps a whole mount and a session looks it up by the mount's
    prefix, so on a folder inside a mount it would load and cap nothing.
    A key that is no mount here, or lies only under the root, stays
    legal: it may name a mount not attached yet, one since unmounted, or
    one of another workspace sharing the profile table. Any key may
    still carry ``commands`` and ``paths``.

    Args:
        profile (SessionProfile): the document.
        mounts (Iterable[str]): the workspace's mount prefixes.

    Raises:
        PolicyError: a key with a mode lies inside a mount other than the
            root and is not a mount itself.
    """
    prefixes = {norm(prefix) for prefix in mounts}
    for key, entry in (profile.mounts or {}).items():
        if entry.mode is None or key in prefixes:
            continue
        owner = max(
            (p for p in prefixes if p != "/" and key.startswith(p + "/")),
            key=len,
            default=None,
        )
        if owner is None:
            continue
        raise PolicyError(
            f"mounts[{key}]: a mode applies to a whole mount and {key} is "
            f"not one; put the mode on the mount {owner}, or give the "
            f"folder a mode with mounts[{owner}].paths.show"
        )


def profile_to_dict(profile: SessionProfile) -> dict[str, Any]:
    """A profile as the document that parses back to it: the shape a
    ``profiles:`` entry has in YAML, which either host reads.

    ``model_dump`` writes that document except in three blocks: a show
    entry dumps as a row rather than a path mapped to its mode, and a
    command tree dumps as its typed nodes (``tree_doc`` writes it back).
    Those blocks are spelled here,
    the limits and process scopes keep their unset fields, as the
    session record writes them on both hosts, and an env entry is
    written with the fields its author set, a managed one as its
    pointer. A policy program's ``env`` is written the same way, and
    left out when empty.

    Args:
        profile (SessionProfile): the profile.
    """
    doc = profile.model_dump(
        mode="json",
        exclude_none=True,
        exclude={
            "env",
            "mounts",
            "paths",
            "commands",
            "command_limits",
            "processes",
        },
    )
    if profile.env is not None:
        doc["env"] = {
            name: (
                entry
                if isinstance(entry, str)
                else entry.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_unset=True,
                    exclude_none=True,
                )
            )
            for name, entry in profile.env.items()
        }
    for method, programs in (profile.policy or {}).items():
        for program, written in zip(
            programs, doc["policy"][method], strict=True
        ):
            written.pop("env")
            if program.env:
                written["env"] = {
                    name: (
                        value
                        if isinstance(value, str)
                        else value.model_dump(by_alias=True)
                    )
                    for name, value in program.env.items()
                }
    if profile.command_limits is not None:
        doc["command_limits"] = command_limits_to_json(profile.command_limits)
    if profile.processes is not None:
        doc["processes"] = profile.processes.model_dump(
            mode="json", exclude_unset=True
        )
    if profile.mounts is not None:
        doc["mounts"] = {
            prefix: _mount_doc(entry)
            for prefix, entry in profile.mounts.items()
        }
    if profile.paths is not None:
        doc["paths"] = _paths_doc(profile.paths)
    if profile.commands is not None:
        doc["commands"] = tree_doc(profile.commands)
    return doc


def profile_from_dict(doc: Mapping[str, Any]) -> SessionProfile:
    """The profile a document states, as ``profile_to_dict`` writes it.

    Args:
        doc (Mapping[str, Any]): the document.
    """
    return SessionProfile.model_validate(doc)


def _mount_doc(entry: ProfileMount) -> dict[str, Any]:
    doc: dict[str, Any] = {}
    if entry.mode is not None:
        doc["mode"] = entry.mode.value
    if entry.paths is not None:
        doc["paths"] = _paths_doc(entry.paths)
    if entry.commands is not None:
        doc["commands"] = tree_doc(entry.commands)
    return doc


def _paths_doc(block: PathsBlock) -> dict[str, Any]:
    # A path shown twice answers with the weaker of its modes, and an
    # entry without one states visibility only (it sets no mode), so the
    # mapping keeps that answer for each path.
    show: dict[str, MountMode | None] = {}
    for e in block.show:
        held = show.get(e.path)
        show[e.path] = (
            e.mode
            if held is None
            else held
            if e.mode is None
            else weaker_mode(held, e.mode)
        )
    return {
        "hide": list(block.hide),
        "show": {
            path: mode.value if mode is not None else None
            for path, mode in show.items()
        },
        "reasons": [
            {"patterns": list(g.patterns), "reason": g.reason}
            for g in block.reasons
        ],
    }


@dataclass(frozen=True, slots=True)
class ProfileSetup:
    """What a profile seeds a new session with; the agent's to change
    afterwards, so a stored session keeps its own.

    Args:
        env (dict[str, str | EnvVar] | None): the env entries to seed.
        cwd (str | None): the working directory to start in.
    """

    env: dict[str, str | EnvVar] | None = None
    cwd: str | None = None


@dataclass(frozen=True, slots=True)
class ProfilePolicies:
    """What a profile lets a session do, for the policy chain to judge.

    Args:
        mount_modes (dict[str, MountMode] | None): the mode each mount
            section states; a mount absent from the map keeps its own.
        commands (AdmissionRules | None): the admission rules, its own
            and its mount sections' in one list.
        scripts (ProfileScripts): the profile's policy programs by
            method, which ``ScriptPolicy`` runs at that method.
        command_limits (Mapping[str, Limit] | None): per-command output
            bounds.
        processes (ProcessPermissions): whose processes the session may
            stop and how many it may hold.
        network (NetworkSetting | None): where the session's lines may
            connect besides the workspace's ``network``.
    """

    mount_modes: dict[str, MountMode] | None = None
    commands: AdmissionRules | None = None
    scripts: ProfileScripts = field(default_factory=dict)
    command_limits: Mapping[str, Limit] | None = None
    processes: ProcessPermissions = DEFAULT_PROCESS_PERMISSIONS
    network: NetworkSetting | None = None


@dataclass(frozen=True, slots=True)
class CompiledProfile:
    """What an effective profile compiles to: the setup a session starts
    from, what exists for it, and what it may do.

    Args:
        setup (ProfileSetup): the env and cwd a new session starts with.
        visibility (Visibility): what exists for the session, which the
            views and the op boundary read.
        policies (ProfilePolicies): what the session may do, which the
            policy chain judges.
        hide_reasons (tuple[HideReason, ...]): the operator's reasons
            for grouped hides, never rendered to the agent.
        profile (str | None): the profile's name, empty for a document
            passed without one, None for no profile; who the session
            runs as.
    """

    setup: ProfileSetup = ProfileSetup()
    visibility: Visibility = DEFAULT_VISIBILITY
    policies: ProfilePolicies = ProfilePolicies()
    hide_reasons: tuple[HideReason, ...] = ()
    profile: str | None = None

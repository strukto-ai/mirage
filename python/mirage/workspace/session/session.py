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

import time
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any

from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource
from mirage.policy.types import (AdmissionRules, Decision, HideReason,
                                 ProfileScript)
from mirage.secrets.config import EnvVar
from mirage.shell.array import ShellArray
from mirage.shell.constants import RANDOM, RANDOM_UNSET, SHELL_ARGV0
from mirage.shell.types import FunctionBody
from mirage.shell.variable import (ManagedRef, ShellVar, VarAttr,
                                   attrs_from_letters, stored_attrs,
                                   with_value)
from mirage.types import (HiddenPaths, HiddenVars, MountMode, ShowEntry,
                          ShownPaths)
from mirage.workspace.session.constants import (CHILD_SHELL_FIELDS,
                                                INHERITED_FIELDS)

from mirage.workspace.session.serialize import (  # isort: skip
    commands_from_dict, commands_to_dict, decision_from_dict, decision_to_dict,
    script_from_dict, script_to_dict)


def copy_state(value: Any) -> Any:
    """Copy one session field deeply enough that a child cannot write back.

    Args:
        value (Any): the field value.
    """
    if isinstance(value, ShellVar):
        # The record is frozen, but an indexed or associative value is
        # a live container, so the copy has to reach inside it.
        return with_value(value, copy_state(value.value))
    if isinstance(value, dict):
        return {k: copy_state(v) for k, v in value.items()}
    if isinstance(value, set):
        return set(value)
    if isinstance(value, list):
        return list(value)
    return value


def vars_from_env(env: Mapping[str, str]) -> dict[str, ShellVar]:
    """Variable records for a plain name/value map.

    The one conversion from the shape an embedder speaks (a process
    environment) to the shape the session stores. Every seeded name is
    exported, because a process environment is by definition the
    exported set: these are the names the embedder means a child
    runtime to inherit, and `env_snapshot` hands on only what carries
    the attribute. Seeding them plain would leave them visible to `$X`
    and invisible to every runtime, which is not what an embedder
    passing an env dict is asking for.

    Args:
        env (Mapping[str, str]): the name/value pairs to seed.
    """
    exported = frozenset({VarAttr.EXPORT})
    return {name: ShellVar(value, exported) for name, value in env.items()}


def vars_from_dict(env: Mapping[str, str],
                   attrs: Mapping[str, str]) -> dict[str, ShellVar]:
    """Variable records for a stored session's two halves.

    The restore side of `to_dict`. `env` carries every scalar and
    `attrs` the letter cluster for the names that have one, so a name
    in `attrs` alone is bash's declared-but-unset third state
    (``export Z``) and restores with no value.

    Not `vars_from_env`: that one reads a bare map as a *process*
    environment and exports all of it, which is right for an embedder
    handing over an env dict and wrong here, where the attributes were
    recorded. Restoring through it promoted every plain ``X=hello`` to
    an exported one on the first reload.

    Args:
        env (Mapping[str, str]): stored ``name -> value`` pairs.
        attrs (Mapping[str, str]): stored ``name -> letters`` clusters.
    """
    out = {
        name: ShellVar(value, attrs_from_letters(attrs.get(name, "")))
        for name, value in env.items()
    }
    for name, letters in attrs.items():
        if name not in out:
            out[name] = ShellVar(None, attrs_from_letters(letters))
    return out


def vars_from_entries(
    entries: Mapping[str, str | EnvVar | Mapping[str, Any]]
) -> dict[str, ShellVar]:
    """Variable records for a workspace env block.

    The declaration side of the env plane: a bare string is the literal
    short form (exported, like `vars_from_env`), a mapping is coerced
    through `EnvVar`, and a managed entry becomes bash's third state --
    exported, unset -- carrying the pointer as `ManagedRef`. After this
    translation the session vars are the only truth the fill step
    reads.

    Args:
        entries (Mapping[str, str | EnvVar | Mapping[str, Any]]): the
            env block, name -> entry.
    """
    out: dict[str, ShellVar] = {}
    for name, entry in entries.items():
        if isinstance(entry, str):
            entry = EnvVar(value=entry)
        elif not isinstance(entry, EnvVar):
            entry = EnvVar.model_validate(entry)
        attrs = set()
        if entry.provider is not None:
            ref = ManagedRef(entry.provider, entry.ref, entry.key or name,
                             entry.fetch == "eager")
            attrs.add(VarAttr.EXPORT)
            if entry.readonly:
                attrs.add(VarAttr.READONLY)
            out[name] = ShellVar(None, frozenset(attrs), managed=ref)
            continue
        if entry.export:
            attrs.add(VarAttr.EXPORT)
        if entry.readonly:
            attrs.add(VarAttr.READONLY)
        out[name] = ShellVar(entry.value, frozenset(attrs))
    return out


def vars_to_fields(table: Mapping[str, ShellVar]) -> dict[str, Any]:
    """The stored shape of a bare variable table.

    The three keys a stored session writes (`to_dict`): ``env`` holds
    the plain scalars, ``var_attrs`` the letter clusters, ``managed``
    the pointers -- and a managed name serializes as its pointer, never
    its value, the same rule the session codec states. This exists for
    the workspace env template, a variable table with no session around
    it, so a snapshot or copy can carry the declaration.

    Args:
        table (Mapping[str, ShellVar]): the variable table.
    """
    managed = {
        name: var.managed
        for name, var in table.items() if var.managed is not None
    }
    fields: dict[str, Any] = {
        "env": {
            name: var.value
            for name, var in table.items()
            if isinstance(var.value, str) and name not in managed
        },
        "var_attrs": {
            name: stored_attrs(var)
            for name, var in table.items() if var.attrs
        },
    }
    if managed:
        refs: dict[str, dict[str, str]] = {}
        for name, ref in managed.items():
            entry = {"from": ref.source, "ref": ref.ref, "key": ref.key}
            if ref.eager:
                entry["fetch"] = "eager"
            refs[name] = entry
        fields["managed"] = refs
    return fields


def vars_from_fields(data: Mapping[str, Any]) -> dict[str, ShellVar]:
    """The variable table a `vars_to_fields` payload restores.

    `vars_from_dict` reads the two plain halves; each managed name then
    restores declared-but-unfetched, its value forced back to None so a
    payload that smuggles one in is discarded rather than trusted --
    exactly how `from_dict` restores a stored session's vars.

    Args:
        data (Mapping[str, Any]): the stored fields.
    """
    out = vars_from_dict(data.get("env") or {}, data.get("var_attrs") or {})
    for name, m in (data.get("managed") or {}).items():
        var = out.get(name, ShellVar(None, frozenset({VarAttr.EXPORT})))
        out[name] = replace(var,
                            value=None,
                            managed=ManagedRef(m["from"], m["ref"], m["key"],
                                               m.get("fetch") == "eager"))
    return out


@dataclass
class Session:
    session_id: str
    cwd: str = "/"
    # The spelling `cd` arrived at: `..` simplified textually, symlinks
    # left alone. bash reports it as `$PWD` and `pwd -L`, and applies the
    # next `cd`'s `..` to it. None whenever it would equal `cwd`, which is
    # every session that has not walked through a symlink. `cwd` stays
    # physical because it is what every operand resolves against.
    logical_cwd: str | None = None
    # One record per variable: value plus attributes. This is the whole
    # variable store -- `env`, `arrays` and `readonly_vars` are read-only
    # projections of it, so a name cannot be a scalar in one container
    # and an array in another, and an attribute cannot drift from the
    # value it describes.
    vars: dict[str, ShellVar] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    functions: dict[str, FunctionBody] = field(default_factory=dict)
    # The functions `readonly -f` has frozen. A set beside `functions`
    # rather than a flag on the body because a body is a list of parsed
    # nodes shared with the parser, and the readonly fact is the
    # session's, not the definition's. Kept in step with the readonly
    # *variable* set only by name: `readonly -f f` and `readonly f` are
    # two different frozen things in bash, and each refuses in its own
    # voice.
    readonly_functions: set[str] = field(default_factory=set)
    last_exit_code: int = 0
    # `${PIPESTATUS[@]}`: the exit status of every segment of the last
    # pipeline, where a simple command is a one-segment pipeline. Written
    # only through `record_status` (`executor/statement.py`), the one
    # door `$?` goes through as well, so the two can never disagree.
    # Empty in a fresh shell, as bash's is: the first `${PIPESTATUS[*]}`
    # expands to nothing until a statement records one.
    pipe_status: tuple[int, ...] = ()
    shell_options: dict[str, bool] = field(default_factory=dict)
    # `shopt` options, kept apart from `set -o` ones because bash keeps
    # two vocabularies (`shopt -o` is the bridge). Only the names set
    # away from their default are stored; SHOPT_DEFAULTS supplies the
    # rest, so a listing prints every option bash knows.
    shopts: dict[str, bool] = field(default_factory=dict)
    # `alias NAME=VALUE` definitions. A subshell inherits them like a
    # forked shell would, and a nested `bash`/`sh` gets a copy that is
    # put back afterwards, the same rule functions already follow.
    aliases: dict[str, str] = field(default_factory=dict)
    # The file-creation mask. bash's default for a fresh shell, and
    # exactly what mirage's 644/755 defaults for a new entry are.
    umask: int = 0o022
    mount_modes: dict[str, MountMode] | None = None
    # Per-session visibility narrowing, siblings of mount_modes: None
    # means unrestricted, the doors enforce (data door for paths, the
    # session door for vars), fork carries them, to_dict serializes.
    hidden_paths: HiddenPaths | None = None
    # The show half of the path axis: re-opened subtrees and per-subtree
    # modes, resolved against hidden_paths by anchor depth.
    shown_paths: ShownPaths | None = None
    hidden_vars: HiddenVars | None = None
    # The operator's reasons for grouped hides: never rendered to the
    # agent (a reason on ENOENT would confirm the path exists),
    # persisted so the host's read-back doors survive a restart.
    hide_reasons: tuple[HideReason, ...] = ()
    # The profile's admission rules, compiled: its allow list, its ask and
    # deny rules, and every rule its mount entries carry. One document,
    # so there is nothing above it to join with. A durable restriction
    # like hidden_paths, so it persists with the session record.
    commands: AdmissionRules | None = None
    # The profile's per-command script, evaluated by ScriptPolicy at the
    # admission gate. A durable restriction like commands, so it
    # persists with the session record.
    script: ProfileScript | None = None
    # The name of the profile the session runs under, None for an
    # unrestricted session. What an owner-rendering command prints as
    # the group. Stamped by the profile like script, so it persists.
    profile: str | None = None
    # The host's standing answers to asked lines (design 3.9): session
    # state like functions and cwd, persisted, read and written through
    # the manager by id so a fork shares them, never another session's.
    decisions: tuple[Decision, ...] = ()
    generation: int = 0
    pipeline_timeout_seconds: float | None = None
    last_bg_job_id: int | None = None
    positional_args: list[str] = field(default_factory=list)
    # What `$0` expands to. None is the shell itself; a nested `bash`/`sh`
    # sets it to the script file it is running, or to the name given after
    # `-c`, and restores it afterwards.
    script_name: str | None = None
    # Transient `set -e` marker: True when the failure just returned
    # came from a short-circuited &&/|| branch or a `!`-negated command,
    # which bash exempts from errexit. Reset on every node execution.
    errexit_immune: bool = field(default=False, repr=False)
    # Depth of nested `source`/`.` execution: `return` is legal and the
    # program loop absorbs its signal only while a file is being sourced.
    source_depth: int = field(default=0, repr=False)
    _stdin_buffer: AsyncLineIterator | None = field(default=None, repr=False)
    _stdin_source: ByteSource | None = field(default=None, repr=False)
    # Variables shadowed by `local` / `declare` in the running function;
    # a None value means the caller had no variable of that name. One
    # stack, not one per container: a local shadows the whole record, so
    # its value and its attributes are saved and restored together.
    _local_vars: (dict[str, ShellVar | None]
                  | None) = field(default=None, repr=False)
    # Every function frame on the call path, outermost first; the last
    # is `_local_vars`. `declare -g` inside a nested call needs the
    # outermost frame that shadows a name, since that frame's saved
    # record is the global one.
    _local_frames: list[dict[str,
                             ShellVar | None]] = field(default_factory=list,
                                                       repr=False)
    # The caller's `RANDOM` marker for every frame that shadows the
    # name, innermost last: a local `RANDOM` is an ordinary variable for
    # the function's extent, and the generator resumes when it returns.
    _local_random: list[str | None] = field(default_factory=list, repr=False)
    # Hidden `getopts` state: the 1-based char offset within the current
    # word being scanned, plus the OPTIND value that offset belongs to.
    # A caller resetting OPTIND (e.g. to 1) makes the seen value stale,
    # which restarts the scan, matching bash's internal char pointer.
    _getopts_pos: int = field(default=1, repr=False)
    _getopts_optind: int | None = field(default=None, repr=False)
    # Command-substitution tracking for assignment statements: how many
    # substitutions have run in this session, and the status of the
    # most recent one. An assignment statement snapshots the count
    # before expanding its value and, when it grew, reports the last
    # substitution's status as its own (bash: `x=$(false)` exits 1,
    # `x=abc` exits 0).
    _cmdsub_seq: int = field(default=0, repr=False)
    _cmdsub_status: int = field(default=0, repr=False)
    # A pipeline's per-segment statuses, parked by `handle_pipe` for the
    # statement boundary that closes it to claim. None between them.
    _pipe_status_pending: tuple[int, ...] | None = field(default=None,
                                                         repr=False)
    # `$RANDOM`'s generator state and the seed word it last consumed
    # (`session/rng.py`). A child shell reseeds, as bash's does, and the
    # parent gets its own state back (`snapshot` / `restore`).
    _random_state: int | None = field(default=None, repr=False)
    _random_seed: str | None = field(default=None, repr=False)
    _random_last: int = field(default=0, repr=False)
    # Scoped by the executing node so diagnostics follow its redirections.
    _diagnostics: list[str | bytes] = field(default_factory=list, repr=False)
    # Alias bookkeeping. bash expands an alias when it *parses* the line
    # that uses it, so a definition takes effect from the next line read
    # (`alias x=..; x` on one line finds no `x`; the same two statements
    # on two lines do). mirage parses a whole program before running any
    # of it, so the rule is kept as a mark: each program loop entered
    # gets a parse id, an alias remembers the (parse, row) it was
    # defined at, and a use on that same parse and row does not expand.
    # `_alias_stack` names the aliases being expanded, so a value whose
    # first word is the alias itself (`alias ls='ls -1'`) stops there.
    # `exec` redirect-only state: where the shell's own stdout, stderr
    # and stdin point after a bare `exec > file` / `exec 2> file` /
    # `exec < file`. None is the terminal (the workspace's own output);
    # `""` is a closed descriptor (`exec >&-`), whose writes are
    # dropped. `_exec_opened` names the targets already truncated, so a
    # later statement appends rather than re-truncating.
    exec_stdout: str | None = None
    exec_stdout_append: bool = False
    exec_stderr: str | None = None
    exec_stderr_append: bool = False
    exec_stdin: bytes | None = None
    exec_stdin_unreadable: bool = False
    # What fd 0 holds when it is not its own read end: `CLOSED` after
    # `exec <&-`, a writing stream's identity after `exec 0<&1`, so a
    # later dup from fd 0 copies that (`exec 2<&0` then writes to
    # stdout) or is refused (`0: Bad file descriptor`); None for the
    # read end itself.
    exec_stdin_identity: str | None = None
    _exec_opened: set[str] = field(default_factory=set, repr=False)
    _parse_seq: int = field(default=0, repr=False)
    _parse_current: int = field(default=0, repr=False)
    _alias_marks: dict[str, tuple[int, int]] = field(default_factory=dict,
                                                     repr=False)
    _alias_stack: list[str] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict[str, Any]:
        # A managed name serializes as its pointer, never its value: a
        # stored session may leak only where a secret lives. `env` skips
        # the name (the fetched plaintext must not land in the record)
        # while `var_attrs` keeps its letters, so a payload with the
        # `managed` key stripped still restores the name as
        # attributed-unset rather than dropping it.
        managed = {
            name: var.managed
            for name, var in self.vars.items() if var.managed is not None
        }
        # `env` is every scalar and `var_attrs` the letters set on the
        # names that carry any, rather than one key holding both: `env`
        # is the shape an embedder writes and another language reads, so
        # it stays a plain name/value map, and the attributes ride
        # beside it. Without the second key a reload could only guess,
        # and guessing "exported" turned every plain `X=hello` into an
        # exported one on the first round trip.
        data = {
            "session_id": self.session_id,
            "cwd": self.cwd,
            "env": {
                n: v
                for n, v in self.env.items() if n not in managed
            },
            "created_at": self.created_at,
            "generation": self.generation,
        }
        # Always written, even empty, because its *presence* is the
        # discriminator: a payload without it is read as a bare process
        # environment and every name in it comes back exported. Writing
        # it only when non-empty made `export -n X` (or any session whose
        # last attribute was cleared) serialize as a process environment,
        # so the reload re-exported everything it held.
        data["var_attrs"] = {
            name: stored_attrs(var)
            for name, var in self.vars.items() if var.attrs
        }
        if managed:
            refs: dict[str, dict[str, str]] = {}
            for name, ref in managed.items():
                entry = {"from": ref.source, "ref": ref.ref, "key": ref.key}
                if ref.eager:
                    entry["fetch"] = "eager"
                refs[name] = entry
            data["managed"] = refs
        if self.mount_modes is not None:
            data["mount_modes"] = {
                prefix: mode.value
                for prefix, mode in self.mount_modes.items()
            }
        if self.hidden_paths is not None:
            data["hidden_paths"] = {
                "paths": list(self.hidden_paths.paths),
                "patterns": list(self.hidden_paths.patterns),
            }
        if self.shown_paths is not None:
            data["shown_paths"] = {
                "entries": [{
                    "path": e.path
                } if e.mode is None else {
                    "path": e.path,
                    "mode": e.mode.value
                } for e in self.shown_paths.entries]
            }
        if self.hide_reasons:
            data["hide_reasons"] = [{
                "patterns": list(g.patterns),
                "reason": g.reason
            } for g in self.hide_reasons]
        if self.hidden_vars is not None:
            data["hidden_vars"] = {
                "names": list(self.hidden_vars.names),
                "patterns": list(self.hidden_vars.patterns),
            }
        if self.commands is not None:
            data["commands"] = commands_to_dict(self.commands)
        if self.script is not None:
            data["script"] = script_to_dict(self.script)
        if self.profile is not None:
            data["profile"] = self.profile
        if self.decisions:
            data["decisions"] = [decision_to_dict(d) for d in self.decisions]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Session":
        if "env" in data or "var_attrs" in data or "managed" in data:
            data = dict(data)
            env = data.pop("env", {})
            attrs = data.pop("var_attrs", None)
            managed = data.pop("managed", None)
            # No `var_attrs` at all means the payload is a bare process
            # environment -- an embedder's dict, or a record another
            # writer hand-built -- so every name in it is exported,
            # which is what a process environment means. With the key
            # present the attributes were recorded and are restored as
            # they were written.
            out_vars = (vars_from_env(env)
                        if attrs is None else vars_from_dict(env, attrs))
            # A managed name restores declared-but-unfetched. The value
            # is forced back to None: a stored session must never carry
            # the plaintext, so one a tampered payload smuggles into
            # `env` is discarded rather than trusted.
            for name, m in (managed or {}).items():
                var = out_vars.get(name,
                                   ShellVar(None, frozenset({VarAttr.EXPORT})))
                out_vars[name] = replace(var,
                                         value=None,
                                         managed=ManagedRef(
                                             m["from"], m["ref"], m["key"],
                                             m.get("fetch") == "eager"))
            data["vars"] = out_vars
        modes = data.get("mount_modes")
        paths = data.get("hidden_paths")
        shown = data.get("shown_paths")
        reasons = data.get("hide_reasons")
        vars_ = data.get("hidden_vars")
        commands = data.get("commands")
        script = data.get("script")
        decisions = data.get("decisions")
        if (modes is not None or paths is not None or shown is not None
                or reasons is not None or vars_ is not None
                or commands is not None or script is not None
                or decisions is not None):
            data = dict(data)
        if modes is not None:
            data["mount_modes"] = {
                prefix: MountMode(mode)
                for prefix, mode in modes.items()
            }
        if paths is not None:
            data["hidden_paths"] = HiddenPaths(
                paths=tuple(paths.get("paths", ())),
                patterns=tuple(paths.get("patterns", ())))
        if shown is not None:
            data["shown_paths"] = ShownPaths(entries=tuple(
                ShowEntry(path=e["path"],
                          mode=MountMode(e["mode"]) if "mode" in e else None)
                for e in shown.get("entries", ())))
        if reasons is not None:
            data["hide_reasons"] = tuple(
                HideReason(patterns=tuple(g.get("patterns", ())),
                           reason=g.get("reason", "")) for g in reasons)
        if vars_ is not None:
            data["hidden_vars"] = HiddenVars(
                names=tuple(vars_.get("names", ())),
                patterns=tuple(vars_.get("patterns", ())))
        if commands is not None:
            data["commands"] = commands_from_dict(commands)
        if script is not None:
            data["script"] = script_from_dict(script)
        if decisions is not None:
            data["decisions"] = tuple(decision_from_dict(d) for d in decisions)
        return cls(**data)

    @property
    def argv0(self) -> str:
        """What ``$0`` expands to.

        None is the shell itself; a nested `bash`/`sh` sets it to the
        script it is running, or to the name given after `-c`. An empty
        name is a name, so it is not folded into the default: GNU
        ``bash -c 'echo "[$0]"' ""`` prints ``[]``.
        """
        return SHELL_ARGV0 if self.script_name is None else self.script_name

    @property
    def env(self) -> Mapping[str, str]:
        """The scalar variables, by name.

        A mappingproxy, so an assignment into it raises instead of
        landing in a throwaway dict -- silent loss is the exact failure
        this store exists to remove.

        A read-only projection of `vars`, not a container: a writer goes
        through `SessionView.set` (or `seed_var` when seeding a session
        before it is narrowed), so a `pre_session` policy sees every
        write. `state.py` has always documented that rule; making the
        mapping read-only is what stops it being walked around by
        assigning into storage.
        """
        return MappingProxyType({
            name: var.value
            for name, var in self.vars.items() if isinstance(var.value, str)
        })

    @property
    def arrays(self) -> Mapping[str, ShellArray]:
        """The indexed arrays, by name. Read-only, like `env`."""
        return MappingProxyType({
            name: var.value
            for name, var in self.vars.items() if isinstance(var.value, list)
        })

    @property
    def assocs(self) -> Mapping[str, dict[str, str]]:
        """The associative arrays, by name. Read-only, like `env`."""
        return MappingProxyType({
            name: var.value
            for name, var in self.vars.items() if isinstance(var.value, dict)
        })

    @property
    def readonly_vars(self) -> frozenset[str]:
        """The names `readonly` has marked. Read-only, like `env`."""
        return frozenset(name for name, var in self.vars.items()
                         if VarAttr.READONLY in var.attrs)

    def __post_init__(self) -> None:
        # bash exports `$PWD` from startup, so a session that has never
        # run `cd` still has one. Seeding here rather than at lookup time
        # is what makes it an ordinary variable: assignable, unsettable,
        # and listed by `env`. "Exports" is literal -- it carries the
        # attribute, which is what keeps it in `env` now that the
        # process view is the exported set rather than every string.
        self.vars.setdefault("PWD",
                             ShellVar(self.cwd, frozenset({VarAttr.EXPORT})))

    def fork(self, **overrides: Any) -> "Session":
        """Return a copy of this session with overrides applied.

        Every inherited field is copied deeply enough that mutations on
        the fork do not leak back into the source. The field list is
        INHERITED_FIELDS rather than a literal written out here, so a
        field added to the dataclass is propagated by construction.

        A caller that moves the fork with ``cwd`` supplies a physical
        path with no typed spelling behind it, so the source's logical
        name is dropped rather than left describing where the fork is
        not -- the same reasoning as `shell_dirs.set_cwd`. Deciding it
        here rather than at each call site is what keeps
        ``execute(cwd=...)`` from reporting the persistent session's old
        directory from ``pwd``.

        Args:
            **overrides: Field-name kwargs to override on the copy.
        """
        defaults: dict[str, Any] = {
            name: copy_state(getattr(self, name))
            for name in INHERITED_FIELDS
        }
        defaults.update(overrides)
        if "cwd" in overrides and "logical_cwd" not in overrides:
            defaults["logical_cwd"] = None
            # `$PWD` names where the session is, so it follows the move
            # even when the caller also supplied an env to layer on.
            defaults["vars"] = {
                **defaults["vars"], "PWD":
                ShellVar(overrides["cwd"], frozenset({VarAttr.EXPORT}))
            }
        return Session(**defaults)

    def snapshot(self) -> dict[str, Any]:
        """Copy the state a child shell runs on top of.

        Args:
            None
        """
        saved = {
            name: copy_state(getattr(self, name))
            for name in CHILD_SHELL_FIELDS
        }
        # A child shell reseeds `$RANDOM`, as bash's does: the generator
        # starts fresh, and the seed word follows the stored value so an
        # assignment the parent made is not replayed as a reseed. `unset
        # RANDOM` stays unset.
        if self._random_seed != RANDOM_UNSET:
            var = self.vars.get(RANDOM)
            self._random_seed = (var.value if var is not None
                                 and isinstance(var.value, str) else None)
            self._random_state = None
            self._random_last = 0
        return saved

    def restore(self, state: dict[str, Any]) -> None:
        """Put back a snapshot, ending a child shell.

        Args:
            state (dict[str, Any]): what ``snapshot`` returned.
        """
        for name, value in state.items():
            setattr(self, name, value)

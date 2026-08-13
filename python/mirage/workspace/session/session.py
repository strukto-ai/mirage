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
from dataclasses import dataclass, field
from typing import Any

from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource
from mirage.shell.array import ShellArray
from mirage.shell.constants import SHELL_ARGV0
from mirage.shell.types import FunctionBody
from mirage.types import HiddenPaths, HiddenVars, MountMode

# What a fork of this session carries over. Written down once because
# `fork` builds a copy from it and `tests/workspace/session/test_session.py`
# asserts that every dataclass field is either here or in
# TRANSIENT_FIELDS, so a field added later cannot be silently dropped by
# a hand-written literal the way `script_name` was.
INHERITED_FIELDS: tuple[str, ...] = (
    "session_id",
    "cwd",
    "logical_cwd",
    "env",
    "created_at",
    "functions",
    "last_exit_code",
    "shell_options",
    "readonly_vars",
    "arrays",
    "mount_modes",
    "hidden_paths",
    "hidden_vars",
    "generation",
    "pipeline_timeout_seconds",
    "last_bg_job_id",
    "positional_args",
    "script_name",
    "_getopts_pos",
    "_getopts_optind",
)

# State that belongs to the line being executed, not to the shell, so a
# fork starts it fresh: the errexit marker, the source nesting depth, the
# stdin the caller happened to pass and the running function's locals.
TRANSIENT_FIELDS: tuple[str, ...] = (
    "errexit_immune",
    "source_depth",
    "_stdin_buffer",
    "_stdin_source",
    "_local_vars",
    "_local_arrays",
    "_cmdsub_seq",
    "_cmdsub_status",
)

# What a child shell gets its own copy of, and the parent gets back
# afterwards. A `( … )` subshell and a nested `bash`/`sh` are both child
# shells and both read this list, so neither can drift into isolating a
# field the other leaks. `last_exit_code` is deliberately absent: `$?`
# after a child shell is the child's status, which is the one thing it
# reports back.
CHILD_SHELL_FIELDS: tuple[str, ...] = (
    "cwd",
    "logical_cwd",
    "source_depth",
    "env",
    "functions",
    "shell_options",
    "readonly_vars",
    "arrays",
    "positional_args",
    "script_name",
    "last_bg_job_id",
    "_getopts_pos",
    "_getopts_optind",
)


def copy_state(value: Any) -> Any:
    """Copy one session field deeply enough that a child cannot write back.

    Args:
        value (Any): the field value.
    """
    if isinstance(value, dict):
        return {k: copy_state(v) for k, v in value.items()}
    if isinstance(value, set):
        return set(value)
    if isinstance(value, list):
        return list(value)
    return value


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
    env: dict[str, str] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    functions: dict[str, FunctionBody] = field(default_factory=dict)
    last_exit_code: int = 0
    shell_options: dict[str, bool] = field(default_factory=dict)
    readonly_vars: set[str] = field(default_factory=set)
    arrays: dict[str, ShellArray] = field(default_factory=dict)
    mount_modes: dict[str, MountMode] | None = None
    # Per-session visibility narrowing, siblings of mount_modes: None
    # means unrestricted, the doors enforce (data door for paths, the
    # session door for vars), fork carries them, to_dict serializes.
    hidden_paths: HiddenPaths | None = None
    hidden_vars: HiddenVars | None = None
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
    _local_vars: dict[str, str | None] | None = field(default=None, repr=False)
    # Arrays shadowed by `local -a` / `declare -a` in the running
    # function; None means the caller had no array of that name.
    _local_arrays: (dict[str, ShellArray | None]
                    | None) = field(default=None, repr=False)
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

    def to_dict(self) -> dict[str, Any]:
        data = {
            "session_id": self.session_id,
            "cwd": self.cwd,
            "env": self.env,
            "created_at": self.created_at,
            "generation": self.generation,
        }
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
        if self.hidden_vars is not None:
            data["hidden_vars"] = {
                "names": list(self.hidden_vars.names),
                "patterns": list(self.hidden_vars.patterns),
            }
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Session":
        modes = data.get("mount_modes")
        paths = data.get("hidden_paths")
        vars_ = data.get("hidden_vars")
        if modes is not None or paths is not None or vars_ is not None:
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
        if vars_ is not None:
            data["hidden_vars"] = HiddenVars(
                names=tuple(vars_.get("names", ())),
                patterns=tuple(vars_.get("patterns", ())))
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

    def __post_init__(self) -> None:
        # bash exports `$PWD` from startup, so a session that has never
        # run `cd` still has one. Seeding here rather than at lookup time
        # is what makes it an ordinary variable: assignable, unsettable,
        # and listed by `env`.
        self.env.setdefault("PWD", self.cwd)

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
            defaults["env"] = {**defaults["env"], "PWD": overrides["cwd"]}
        return Session(**defaults)

    def snapshot(self) -> dict[str, Any]:
        """Copy the state a child shell runs on top of.

        Args:
            None
        """
        return {
            name: copy_state(getattr(self, name))
            for name in CHILD_SHELL_FIELDS
        }

    def restore(self, state: dict[str, Any]) -> None:
        """Put back a snapshot, ending a child shell.

        Args:
            state (dict[str, Any]): what ``snapshot`` returned.
        """
        for name, value in state.items():
            setattr(self, name, value)

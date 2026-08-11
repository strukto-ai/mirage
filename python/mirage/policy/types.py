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

from dataclasses import dataclass
from typing import Any, ClassVar, Protocol

from mirage.types import Limit, PathSpec, Producer


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool:
        ...


@dataclass(frozen=True, slots=True)
class Deny:
    """Refuse the command with a message on stderr.

    Args:
        message (str): full stderr text, newline-terminated.
        exit_code (int): the command's exit code; 1 by default, the
            GNU spelling of an operand-level refusal.
    """

    kind: ClassVar[str] = "deny"

    message: str
    exit_code: int = 1


# The closed vocabulary of policy answers: a hook returns an Action to
# state an opinion or None to stay silent. Deny refuses (first opinion
# wins); Limit bounds (every opinion merges to the tightest, Limit.aggr).
# Each hook accepts a fixed set of kinds (VALIDITY), enforced loud.
Action = Deny | Limit


@dataclass(frozen=True, slots=True)
class GuardSpec:
    """A declarative guard: refuse matching commands on matching paths.

    The YAML ``guards:`` block and ``Workspace(guards=[...])`` accept
    this shape; ``Policies.add`` compiles it to a SpecPolicy. Patterns
    match the absolute virtual path with ``*`` (any run, including
    ``/``) and ``?`` (any one character).

    Args:
        reason (str): why the command is refused, shown on stderr.
        commands (tuple[str, ...]): command names the guard applies to;
            empty means every command.
        paths (tuple[str, ...]): path patterns; empty refuses the
            command regardless of its operands.
    """

    reason: str
    commands: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Facts about one classified command, as pre_command hooks see it.

    Args:
        command (str): the command name.
        paths (tuple[PathSpec, ...]): every path the line names, the
            positional operands first and then the values of any
            path-valued flags. What a path-pattern guard matches on.
        operands (tuple[PathSpec, ...]): the positional operands alone.
            A rule that reads a slot by position (mv's source, ln's
            target, tar's files) has to use this: with the flag values
            mixed in, ``tar -xf a.tar -C /mnt`` would read the ``-C``
            destination as a file being archived.
        argv (tuple[str, ...]): raw argv after the command name; the
            hook fires before flag parsing, so shorthand flags are raw
            tokens.
        cwd (str): session working directory.
        registry (MountRootQuery): mount-root oracle for POSIX rules.
    """

    command: str
    paths: tuple[PathSpec, ...]
    argv: tuple[str, ...]
    cwd: str
    registry: MountRootQuery
    operands: tuple[PathSpec, ...] = ()


@dataclass(frozen=True, slots=True)
class OpsContext:
    """Facts about one VFS op, as pre_ops hooks see it.

    Fires at the op doors (the ``ws.ops`` facade, which also serves
    FUSE, and the shell's internal dispatcher), before any backend or
    cache I/O, so it holds however the mount is reached.

    Args:
        op (str): operation name (read, write, unlink, readdir, ...).
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str


@dataclass(frozen=True, slots=True)
class OpsResultContext:
    """One completed VFS op, as post_ops hooks see it.

    Args:
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result (bytes, FileStat, listing,
            ...); a Deny here suppresses it.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    result: Any


@dataclass(frozen=True, slots=True)
class ExecuteResultContext:
    """One finished execute() line, as post_execute hooks see it.

    Fires at the workspace boundary before the line's output stream is
    finalized, so a Limit returned here bounds what the caller sees.

    Args:
        producer (Producer): provenance of the surviving stream (the
            rightmost command, per shell semantics); a Producer with an
            empty command when no dispatch site stamped one.
        exit_code (int): the line's exit code so far.
    """

    producer: Producer
    exit_code: int


VALIDITY: dict[str, frozenset[str]] = {
    "pre_command": frozenset({Deny.kind}),
    "pre_ops": frozenset({Deny.kind}),
    "post_ops": frozenset({Deny.kind, Limit.kind}),
    "post_execute": frozenset({Limit.kind}),
}

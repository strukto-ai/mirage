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
from typing import ClassVar, Protocol

from mirage.types import PathSpec


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool:
        ...


class Action:
    """Base of every policy answer.

    A hook returns an Action to state an opinion or None to stay
    silent. ``kind`` is the wire discriminant, mirrored by the
    TypeScript union tag; each hook accepts a fixed set of kinds
    (VALIDITY), enforced at the seam.
    """

    kind: ClassVar[str] = ""


@dataclass(frozen=True, slots=True)
class Deny(Action):
    """Refuse the command with a message on stderr.

    Args:
        message (str): full stderr text, newline-terminated.
        exit_code (int): the command's exit code; 1 by default, the
            GNU spelling of an operand-level refusal.
    """

    kind: ClassVar[str] = "deny"

    message: str
    exit_code: int = 1


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Facts about one classified command, as pre_command hooks see it.

    Args:
        command (str): the command name.
        paths (tuple[PathSpec, ...]): positional path operands.
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


VALIDITY: dict[str, frozenset[str]] = {
    "pre_command": frozenset({Deny.kind}),
}

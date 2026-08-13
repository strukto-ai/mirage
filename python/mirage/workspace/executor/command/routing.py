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

import dataclasses

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.mount import MountRegistry

# Commands a bare invocation points at the working directory, mapped to
# the typed spelling their synthetic operand carries. GNU find/tree/du/
# ls behave exactly as if `.` had been typed (./-prefixed output); GNU
# grep -r and bare rg print bare relative names (empty raw). Two gates:
# grep only defaults under -r/-R (and ignores stdin, GNU's rule); rg
# yields to an attached stdin, even an empty one (its readable-stdin
# rule). All pinned on debian:stable-slim / ripgrep 14.
CWD_DEFAULT_RAW = {
    "grep": "",
    "rg": "",
    "find": ".",
    "tree": ".",
    "du": ".",
    "ls": ".",
}


def default_cwd_operand(parts: list[str | PathSpec], cmd_name: str,
                        registry: MountRegistry, cwd: str,
                        stdin: ByteSource | None) -> PathSpec | None:
    """The synthetic cwd operand for a CWD_DEFAULT_RAW command typed bare.

    Injected before routing, so mount resolution, fan-out across
    descendant mounts, and :func:`respell_raw` treat it exactly like a
    typed operand; backends never see the difference.

    Args:
        parts (list[str | PathSpec]): classified command words.
        cmd_name (str): command name (a CWD_DEFAULT_RAW key).
        registry (MountRegistry): mount registry resolving the cwd.
        cwd (str): session working directory.
        stdin (ByteSource | None): the line's stdin, consulted for rg.
    """
    spec = SPECS.get(cmd_name)
    if spec is None:
        return None
    argv = [p.virtual if isinstance(p, PathSpec) else p for p in parts[1:]]
    parsed = parse_command(spec, argv, cwd)
    if parsed.paths():
        return None
    if cmd_name == "grep":
        kwargs = parse_to_kwargs(parsed)
        if kwargs.get("r") is not True and kwargs.get("R") is not True:
            return None
    elif cmd_name == "rg" and stdin is not None:
        return None
    operand = classify_bare_path(".", registry, cwd)
    if not isinstance(operand, PathSpec):
        return None
    return dataclasses.replace(operand, raw_path=CWD_DEFAULT_RAW[cmd_name])


def path_flag_scopes(cmd_name: str, argv: list[str],
                     cwd: str) -> list[PathSpec]:
    spec = SPECS.get(cmd_name)
    if spec is None:
        return []
    parsed = parse_command(spec, argv, cwd)
    return [
        PathSpec(virtual=value,
                 directory=value,
                 resource_path="",
                 raw_path=value) for value in parsed.path_flag_values
    ]


def positional_scopes(cmd_name: str, argv: list[str], cwd: str,
                      words: list[str | PathSpec]) -> list[PathSpec]:
    """The path operands a line names positionally, flag values left out.

    Classification turns every path-shaped word into a PathSpec,
    including the value of a path-valued flag, so the classified word
    list cannot tell ``tar -xf a.tar -C /mnt`` (extract INTO a mount)
    from ``tar -cf a.tar /mnt`` (archive a whole mount). Only the spec
    knows which slot a word filled, so this asks it and keeps the
    classified spec for each surviving operand, whose ``raw_path`` is
    what a message should name.

    Args:
        cmd_name (str): command name.
        argv (list[str]): the words after the command name, as typed.
        cwd (str): working directory the line was typed under.
        words (list[str | PathSpec]): the same words, classified.
    """
    spec = SPECS.get(cmd_name)
    if spec is None:
        return [p for p in words if isinstance(p, PathSpec)]
    parsed = parse_command(spec, argv, cwd)
    by_virtual = {p.virtual: p for p in words if isinstance(p, PathSpec)}
    return [
        by_virtual.get(
            value,
            PathSpec(virtual=value,
                     directory=value,
                     resource_path="",
                     raw_path=value)) for value in parsed.paths()
    ]


def merge_scopes(positional: list[PathSpec],
                 flag_scopes: list[PathSpec]) -> list[PathSpec]:
    """Combine positional and path-flag scopes, keeping operand order.

    Args:
        positional (list[PathSpec]): Path operands parsed from the argv tail.
        flag_scopes (list[PathSpec]): Paths carried by path-valued flags.
    """
    merged = list(positional)
    seen = {p.virtual for p in merged}
    for scope in flag_scopes:
        if scope.virtual not in seen:
            seen.add(scope.virtual)
            merged.append(scope)
    return merged

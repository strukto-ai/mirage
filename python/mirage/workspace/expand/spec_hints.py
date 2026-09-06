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

from mirage.commands.builtin.find_parse import exec_spans
from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import CommandSpec, ValueType
from mirage.workspace.mount import MountRegistry


def spec_for_command(
    name: str,
    registry: MountRegistry,
    cwd: str,
) -> CommandSpec | None:
    """Find the spec that classifies a mount command's words.

    The cwd mount's spec wins; the shared SPECS table fills in when
    that mount does not register the command. Every absolute path has
    a mount (the workspace roots an implicit RAM mount), so mount_for
    never fails here; if it ever does, the registry is broken and the
    error should propagate.

    Args:
        name (str): expanded command name.
        registry (MountRegistry): mount registry.
        cwd (str): current working directory.
    """
    spec = registry.mount_for(cwd).spec_for(name)
    if spec is not None:
        return spec
    return SPECS.get(name)


def spec_word_kinds(
    spec: CommandSpec,
    argv: list[str],
    name: str = "",
) -> list[ValueType | None]:
    """Classify argv words into per-position operand kinds.

    Delegates to parse_command so flag syntax (clusters, --flag=value,
    multiple flags, provided_by) classifies identically to dispatch.
    Kinds are positional, not value sets, so the same word can be TEXT
    in one slot and PATH in another (`grep '*.txt' *.txt`). None marks a
    flag token, whose own classification the default handles.

    find's ``-exec`` is the one grammar a spec cannot state (an option
    whose argument is a program, up to a terminator), so its words are
    overridden to TEXT here: the rest slot would otherwise read
    ``echo``, ``{}`` and ``;`` as start points.

    Examples:
        cat file.txt           → [PATH]
        grep pattern file.txt  → [TEXT, PATH]
        find /data -name *.txt → [PATH, None, TEXT]

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
        name (str): the command name, which is what says the words are
            find's.
    """
    # parse_command classifies ignore_tokens as TEXT itself, so there is
    # nothing to override here: leaving them None sent `find \( ... \)`
    # back to the shape heuristic, which read "(" as the bare path "/(".
    kinds = list(parse_command(spec, argv, cwd="/").word_kinds)
    if name == "find":
        for start, end in exec_spans(argv):
            for i in range(start, end + 1):
                kinds[i] = "str"
    return kinds


def spec_word_bases(
    spec: CommandSpec,
    argv: list[str],
    cwd: str,
) -> list[str | None] | None:
    """Per-position base directories for a spec that declares one.

    tar's -C is a chdir for the operands typed after it, so those words
    are not relative to the session cwd at all. The parser already walks
    the line positionally, so it is what says where each word stood;
    this asks it, and only for the one command family that can answer
    (None everywhere else, so 92 of 93 specs pay nothing).

    Args:
        spec (CommandSpec): command specification.
        argv (list[str]): command arguments (without command name).
        cwd (str): the working directory the line was typed under.
    """
    if spec.operand_base is None:
        return None
    return list(parse_command(spec, argv, cwd=cwd).word_bases)

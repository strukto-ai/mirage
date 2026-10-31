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

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TypeAlias

from mirage.commands.config import AggregateFn, CommandFn
from mirage.commands.spec.flag_view import FlagView
from mirage.types import LineFacts, PathSpec

# What a command's options make of one line: a pure, total function of
# its parsed flags and its operands in order, a path operand as the
# PathSpec it was classified as. A value the command refuses answers the
# side that keeps a rule in force.
FactsFn: TypeAlias = Callable[[FlagView, Sequence[str | PathSpec]], LineFacts]


# A generic builder's handler: an ordinary command handler, which reads
# and writes only through the session's files (``command_files(ctx,
# paths)``).
@dataclass(frozen=True)
class GenericCommand:
    """One generic builder: an ordinary handler, ``fn(accessor, paths,
    texts, ctx)``, that reads and writes only through ``ctx.vfs``
    (``command_files``), and what the factory needs to register it.

    Args:
        name (str): the command name.
        fn (CommandFn): the handler.
        write (bool): whether it changes files.
        aggregate (AggregateFn | None): merges a run split across mounts.
        read (bool): whether it reads its operands' content.
        pass_through (bool): it hands on what it reads (cat, head), so
            its input is not split.
        streams (bool): it only reads its operands while its output
            drains (comm, fold), so a cross-mount run hands that output
            on live.
        facts (LineFacts | FactsFn): what a line of it does: one answer
            no option changes, or the function that reads it off the
            line.
    """

    name: str
    fn: CommandFn
    write: bool = False
    aggregate: AggregateFn | None = None
    read: bool = False
    pass_through: bool = False
    streams: bool = False
    facts: LineFacts | FactsFn = LineFacts()

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

from mirage.commands.config import AggregateFn, CommandFn


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
    """

    name: str
    fn: CommandFn
    write: bool = False
    aggregate: AggregateFn | None = None
    read: bool = False
    pass_through: bool = False
    streams: bool = False

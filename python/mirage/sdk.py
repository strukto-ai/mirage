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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexConfig
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import command
from mirage.commands.spec import SPECS, CommandSpec, FlagView, Operand, Option
from mirage.io.types import IOResult
from mirage.ops.generic import OpsTable, make_generic_ops
from mirage.ops.registry import RegisteredOp, op
from mirage.resource.base import BaseResource
from mirage.resource.generic import GenericResource
from mirage.resource.registry import (build_resource, known_resources,
                                      register_resource)
from mirage.types import FileStat, PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob

__all__ = [
    "Accessor",
    "BaseResource",
    "CommandIO",
    "CommandSpec",
    "DEFAULT_MAX_GLOB_MATCHES",
    "FileStat",
    "FlagView",
    "GenericResource",
    "IOResult",
    "IndexCacheStore",
    "IndexConfig",
    "NULL_INDEX",
    "Operand",
    "OpsTable",
    "Option",
    "PathSpec",
    "RegisteredOp",
    "SPECS",
    "build_resource",
    "command",
    "known_resources",
    "make_filetype_commands",
    "make_generic_commands",
    "make_generic_ops",
    "make_resolve_glob",
    "op",
    "register_resource",
    "stream_from_bytes",
]

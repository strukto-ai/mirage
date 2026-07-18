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

from collections.abc import Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexConfig
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.resource.base import BaseResource
from mirage.types import PathSpec


class GenericResource(BaseResource):
    """A full backend generated from one :class:`CommandIO` table.

    The one-file path for custom backends: supply an accessor and the
    core functions on a ``CommandIO`` (readdir/read_bytes/stat at
    minimum), and the whole generic command set — plus glob resolution —
    is wired automatically. Optional fields on the table unlock more
    surface (``write`` enables the byte-mutation family, ``find`` and
    ``du_total`` become native fast paths), and the escape hatches
    mirror what builtin backends use: ``overrides`` suppresses generic
    commands the backend replaces, ``commands`` appends bespoke
    ``@command`` verbs, and ``ops`` registers ``@op`` handlers for FUSE
    and os-interception mounts.

    Args:
        name (str): resource name commands register under; also the
            registry key when the class is exposed via
            ``register_resource`` or a ``mirage.resources`` entry point.
        accessor (Accessor): backend handle passed to every core fn.
        io (CommandIO): the backend's IO table.
        prompt (str): LLM-facing description of the mounted layout.
        write_prompt (str): appended when mounted writable.
        overrides (set[str] | None): generic command names the backend
            replaces (pass the replacements via ``commands``).
        commands (list[Callable] | None): extra ``@command``-decorated
            functions (bespoke verbs or override replacements).
        ops (list[Callable] | None): ``@op``-decorated functions for
            VFS/FUSE dispatch.
        provision_overrides (dict[str, Callable] | None): per-command
            cost estimators replacing the catalog default.
        caches_reads (bool): serve repeat reads from the file cache;
            enable only for stable, read-mostly content.
        index (IndexConfig | None): cache-index configuration.
    """

    def __init__(
        self,
        *,
        name: str,
        accessor: Accessor,
        io: CommandIO,
        prompt: str = "",
        write_prompt: str = "",
        overrides: set[str] | None = None,
        commands: list[Callable] | None = None,
        ops: list[Callable] | None = None,
        provision_overrides: dict[str, Callable] | None = None,
        caches_reads: bool = False,
        index: IndexConfig | None = None,
    ) -> None:
        super().__init__(index=index)
        if not name:
            raise ValueError("GenericResource requires a non-empty name")
        self.name = name
        self.accessor = accessor
        self.io = io
        self.PROMPT = prompt
        self.WRITE_PROMPT = write_prompt
        self.caches_reads = caches_reads
        self._resolve = io.resolve_glob
        for fn in make_generic_commands(
                name,
                io,
                overrides=overrides,
                provision_overrides=provision_overrides):
            self.register(fn)
        for fn in commands or []:
            self.register(fn)
        for fn in ops or []:
            self.register_op(fn)

    async def resolve_glob(self,
                           paths: list,
                           prefix: str = "") -> list[PathSpec]:
        return await self._resolve(self.accessor, paths, self._index)

    def get_state(self) -> dict:
        return {"type": self.name}

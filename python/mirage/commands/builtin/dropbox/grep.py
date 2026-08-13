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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.dropbox.narrow import narrow_scope
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import stream as _stream
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep", resource="dropbox", spec=SPECS["grep"])
async def grep(
    accessor: DropboxAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore = NULL_INDEX,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    resolved: list[PathSpec] = []
    used_search = False
    if paths:
        # -v and -c need the walk: GNU prints non-matching lines (-v) and
        # zero counts (-c) from files a narrowed superset would never
        # visit.
        resolved, used_search = await narrow_scope(
            accessor,
            index,
            paths,
            pattern,
            fixed_string=fl.as_bool("F"),
            recursive=fl.as_bool("r") or fl.as_bool("R"),
            whole_word=fl.as_bool("w"),
            exact_file_set=fl.as_bool("v") or fl.as_bool("c"),
        )
        if used_search and not resolved:
            return b"", IOResult(exit_code=1)

    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(_read, accessor, index),
        read_stream=bound_op(_stream, accessor, index),
        stdin=stdin,
    )

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

from mirage.commands.builtin.types import PrintfLiteral, PrintfPart, PrintfTime
from mirage.commands.builtin.utils.identity import (
    Identity,
    group_name,
    owner_name,
)
from mirage.core.generic.find_eval import printf_kind
from mirage.io.stream import materialize
from mirage.rs.stream import OpenStream, open_stream, stream_output_chunks
from mirage.shell.bytes import byte_view
from mirage.types import FileStat, JsonValue, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.stat_view import content_size


def compile_printf(parts: tuple[PrintfPart, ...]) -> OpenStream:
    """Own one shared formatter for all rows of an action.

    Args:
        parts (tuple[PrintfPart, ...]): The compiled format.
    """
    encoded: list[JsonValue] = []
    for part in parts:
        if isinstance(part, PrintfLiteral):
            encoded.append({"lit": byte_view(part.text)})
        elif isinstance(part, PrintfTime):
            encoded.append({"time": part.letter})
        else:
            encoded.append({"dir": part.code})
    return open_stream("find_printf", {"parts": encoded})


def _facts(
    row: str,
    search: PathSpec,
    st: FileStat | None,
    target: FileStat | None,
    identity: Identity | None,
) -> dict[str, JsonValue]:
    kind = "U" if st is None else printf_kind(st)
    return {
        "path": byte_view(row),
        "base": byte_view(search.raw_path or search.virtual),
        "size": content_size(st) if st is not None else 0,
        "kind": kind,
        "target": ("N" if target is None else printf_kind(target))
        if kind == "l"
        else kind,
        "mode": st.mode if st is not None else None,
        "owner": byte_view(
            owner_name(st.uid if st is not None else None, identity)
        ),
        "group": byte_view(
            group_name(st.gid if st is not None else None, identity)
        ),
        "timestamp": iso_timestamp(st.modified) or 0.0
        if st is not None and st.modified is not None
        else 0.0,
    }


async def render_printf(
    engine: OpenStream,
    row: str,
    search: PathSpec,
    st: FileStat | None,
    target: FileStat | None = None,
    identity: Identity | None = None,
) -> bytes:
    """Render a row, yielding between bounded formatting steps.

    Args:
        engine (OpenStream): The action's owned formatter.
        row (str): The display path.
        search (PathSpec): The walk's starting point.
        st (FileStat | None): The row's stat when required.
        target (FileStat | None): The resolved link target.
        identity (Identity | None): The session identity.
    """
    engine.begin(_facts(row, search, st, target, identity))
    return await materialize(
        stream_output_chunks(engine, b"", owns_stream=False)
    )

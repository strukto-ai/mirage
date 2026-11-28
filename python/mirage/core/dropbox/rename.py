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

import logging
from collections.abc import Mapping
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import lookup, move_path
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.constants import REV
from mirage.core.dropbox.copy import replace_onto
from mirage.core.dropbox.paths import check_path, dropbox_path_of
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def _move_back(
    tm: DropboxTokenManager,
    landed: str,
    back: str,
    made: Mapping[str, Any],
) -> None:
    """Move what landed at ``landed`` back to ``back`` while it is still
    what landed: the entry by id, a file at the rev its move answered.
    Dropbox moves on no condition, so one another writer changed since is
    left where it is.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        landed (str): where it landed.
        back (str): where it came from.
        made (dict[str, Any]): what landed, as the move answered it.
    """
    there = await lookup(tm, landed)
    if (
        there is None
        or there.get("id") != made.get("id")
        or there.get(REV) != made.get(REV)
    ):
        logger.debug("%s changed since it landed; it stays", landed)
        return
    await move_path(tm, landed, back)


async def rename(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """move_v2 rejects an existing destination, but rename(2) replaces
    one: a file outright, and a directory when it is empty. So on a
    conflict the target moves aside, the source takes its name, and the
    target is deleted last, except for a folder that still lists a
    child, where the original error propagates and the generic mv
    reports "Directory not empty" (mirrors msgraph's rename_replace).
    The source moves whole, so only a destination it replaces is held to
    its version (``replace_onto``); a move taken back is left where it
    landed once another writer changed it (``_move_back``).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    await check_path(accessor, src)
    await check_path(accessor, dst)
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    tm = accessor.token_manager
    timer = start_op()
    upto = lost_count()

    moved, _ = await replace_onto(
        tm,
        src,
        dst,
        from_path,
        to_path,
        lambda to: move_path(tm, from_path, to),
        lambda landed, made: _move_back(tm, landed, from_path, made),
        moves=True,
        empty_folder=True,
    )
    folder = moved.get(".tag") != "file"
    op = "rename_prefix" if folder else "rename"
    record(op, src.virtual, "dropbox", 0, timer)
    record(op, dst.virtual, "dropbox", 0, timer)
    lift_lost(src, upto, subtree=folder)
    lift_lost(dst, upto, subtree=folder)

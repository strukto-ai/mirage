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

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    invalidate_after_write,
    invalidate_ancestors,
    native_condition,
    stale,
    write_condition,
)
from mirage.cache.types import WriteCondition
from mirage.core.dropbox.api import (
    copy_path,
    delete_path,
    get_metadata,
    list_folder,
    lookup,
    refused,
)
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.constants import (
    MISSING_SOURCE,
    TAKEN,
    TAKEN_BY_FOLDER,
)
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.errors.fs import enoent
from mirage.errors.types import StaleWriteError
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

T = TypeVar("T")


async def _retaken(
    exc: DropboxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    The held version stays held; a folder there keeps none.

    Args:
        exc (DropboxApiError): Dropbox's answer to the retry.
        cond (WriteCondition | None): the condition the op carries.
        dst (PathSpec): the destination.
    """
    if cond is None or not exc.summary.startswith(TAKEN):
        return None
    if cond.if_match and not exc.summary.startswith(TAKEN_BY_FOLDER):
        return await stale(dst, version=cond.if_match)
    return await stale(dst, gone=True)


async def replace_onto(
    tm: DropboxTokenManager,
    src: PathSpec,
    dst: PathSpec,
    to_path: str,
    op: Callable[[], Awaitable[T]],
    empty_folder: bool,
) -> tuple[T, dict[str, Any] | None]:
    """Run a copy or move, replacing a file that holds the destination name.

    The op goes first, since Dropbox answers a missing source before a
    taken name. A held destination is measured before the op, cleared with
    its rev on a taken name, and refused as gone when a folder took it.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        src (PathSpec): the source, for ENOENT.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.
        op (Callable[[], Awaitable[T]]): the copy or move.
        empty_folder (bool): whether an empty folder there gives way too.

    Returns:
        tuple[T, dict[str, Any] | None]: the op's reply, and the
        destination it replaced when that was looked up.
    """
    cond = await write_condition(dst, "copy")
    rev = None
    if cond is not None and cond.if_match:
        live = live_of(await lookup(tm, to_path))
        rev = await native_condition(dst, cond, live, "copy")
    try:
        return await op(), None
    except DropboxApiError as exc:
        if exc.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith(TAKEN):
            raise
        existing: dict[str, Any] | None = None
        if rev is None:
            existing = await get_metadata(tm, to_path)
            if existing.get(".tag") == "folder" and not (
                empty_folder and not await list_folder(tm, to_path, limit=1)
            ):
                raise
        elif exc.summary.startswith(TAKEN_BY_FOLDER):
            raise await stale(dst, gone=True) from exc
        try:
            await delete_path(tm, to_path, rev)
        except DropboxApiError as err:
            raise (await refused(dst, err, cond, rev)) or err
        try:
            return await op(), existing
        except DropboxApiError as again:
            if again.summary.startswith(MISSING_SOURCE):
                raise enoent(src.virtual) from again
            raise (await _retaken(again, cond, dst)) or again


async def copy(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """copy_v2 copies files and folder subtrees server-side; an existing
    destination FILE is replaced, as cp does (see ``replace_onto``).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    tm = accessor.token_manager
    timer = start_op()
    await replace_onto(
        tm,
        src,
        dst,
        to_path,
        lambda: copy_path(tm, from_path, to_path),
        empty_folder=False,
    )
    record("copy", dst.virtual, "dropbox", 0, timer)
    await invalidate_after_write(dst)
    await invalidate_ancestors(dst)

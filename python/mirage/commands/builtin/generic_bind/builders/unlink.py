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
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import links_of
from mirage.commands.config import Context
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def unlink(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    if not paths:
        raise missing_operand_error("unlink", None)
    paths = await files.resolve_glob(paths)
    if len(paths) > 1:
        raise extra_operand_error("unlink", paths[1].raw_path)
    p = paths[0]
    links = links_of(ctx)
    # unlink(2) never follows, so a trailing slash on a link operand is
    # refused rather than resolved: GNU answers `unlink dlink/` and
    # `unlink flink/` alike with ENOTDIR, where a real directory under a
    # slash is EISDIR. A bare link operand never reaches here at all --
    # the dispatcher removes the link entry, which no backend can see.
    if (
        links is not None
        and p.raw_path.endswith("/")
        and links.stat_at(p.virtual) is not None
    ):
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"unlink: cannot unlink '{p.raw_path}': "
                f"{posix_phrase(FsCondition.ENOTDIR)}\n"
            ).encode(),
        )
    try:
        s = await files.stat(p)
    except FS_ERRORS as exc:
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"unlink: cannot unlink '{p.raw_path}': {fs_strerror(exc)}\n"
            ).encode(),
        )
    if s.type == FileType.DIRECTORY:
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"unlink: cannot unlink '{p.raw_path}': "
                f"{posix_phrase(FsCondition.EISDIR)}\n"
            ).encode(),
        )
    try:
        await files.unlink(p)
    except FS_ERRORS as exc:
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"unlink: cannot unlink '{p.raw_path}': {fs_strerror(exc)}\n"
            ).encode(),
        )
    return None, IOResult()


BUILDER = GenericCommand("unlink", unlink, write=True)

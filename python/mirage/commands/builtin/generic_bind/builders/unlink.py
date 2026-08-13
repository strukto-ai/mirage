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
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def unlink(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise UsageError(
            "unlink: missing operand\n"
            "Try 'unlink --help' for more information.", 1)
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    if len(paths) > 1:
        raise extra_operand_error("unlink", paths[1].raw_path)
    p = paths[0]
    links = opts.ns.links if opts.ns is not None else None
    # unlink(2) never follows, so a trailing slash on a link operand is
    # refused rather than resolved: GNU answers `unlink dlink/` and
    # `unlink flink/` alike with ENOTDIR, where a real directory under a
    # slash is EISDIR. A bare link operand never reaches here at all --
    # the dispatcher removes the link entry, which no backend can see.
    if (links is not None and p.raw_path.endswith("/")
            and links.stat_at(p.virtual) is not None):
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.raw_path}': "
                                      "Not a directory\n").encode())
    try:
        s = await ops.stat(accessor, p)
    except NotADirectoryError:
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.raw_path}': "
                                      "Not a directory\n").encode())
    except FileNotFoundError:
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.raw_path}': "
                                      "No such file or directory\n").encode())
    if s.type == FileType.DIRECTORY:
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.raw_path}': "
                                      "Is a directory\n").encode())
    await ops.require(Operation.UNLINK)(accessor, p)
    return None, IOResult(writes={p.mount_path: b""})


BUILDER = Builder('unlink',
                  unlink,
                  write=True,
                  requirements=frozenset({Operation.UNLINK}))

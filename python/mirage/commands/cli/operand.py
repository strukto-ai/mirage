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

from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.types import PathSpec
from mirage.workspace.files import Files


def first_text(texts: list[str], label: str) -> str:
    """The command's first operand, refused when absent or empty.

    Args:
        texts (list[str]): positional operands as typed.
        label (str): what the operand is, for the message.
    """
    if not texts or not texts[0]:
        raise ValueError(f"{label} is required")
    return texts[0]


async def read_operand(
    vfs: Files | None, path: PathSpec, flag: str, label: str = "read"
) -> bytes:
    """Read the workspace file a flag names.

    An account CLI has no mount of its own, so a file on its line is an
    unrelated workspace file, read through the session's files.

    Args:
        vfs (Files | None): the session's files, None outside a workspace.
        path (PathSpec): the flag's value, resolved against the cwd.
        flag (str): the flag as typed, for the message.
        label (str): the action a missing file's message names.

    Raises:
        ValueError: there is no workspace, or the path does not exist.
    """
    if vfs is None:
        raise ValueError(f"{flag} needs a workspace to read files from")
    try:
        return await vfs.read(path)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise ValueError(
            f"{label} {path.virtual}: {fs_strerror(exc)}"
        ) from None


async def ensure_dir(vfs: Files, path: PathSpec) -> None:
    """Create a directory and every missing directory above it.

    Written out rather than delegated to ``mkdir -p`` because the
    parents flag is a per-backend capability: the ops factory only wires
    ``parents=True`` for backends that declare it, so a plain ``mkdir``
    of ``a/b`` fails on the rest.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the directory.
    """
    missing: list[PathSpec] = []
    current = path
    while current.virtual != "/":
        try:
            await vfs.stat(current)
            break
        except MISS_ERRORS:
            missing.append(current)
            current = current.parent
    for target in reversed(missing):
        try:
            await vfs.mkdir(target)
        except FileExistsError:
            # A parallel download fans out over files that share parents,
            # so two workers can read the same parent as missing and then
            # both create it. EEXIST here says the directory is present,
            # which is what the caller asked for; raising would fail the
            # whole gather over a race that already succeeded.
            continue

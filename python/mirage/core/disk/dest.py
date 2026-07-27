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

from pathlib import Path

from aiofiles.os import path as aio_path

from mirage.types import PathSpec
from mirage.utils.errors import enotdir
from mirage.utils.key_prefix import mounted_path
from mirage.utils.path import ancestors


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def mkdir_component_error(root: Path, spec: PathSpec,
                                key: str) -> OSError | None:
    """The ENOTDIR ``mkdir -p`` owes, named after the component to blame.

    The disk backend has a kernel, so it needs no equivalent of the
    store-backed ``check_mkdir_target``: ``makedirs`` already refuses a
    chain that crosses a plain file, and an existing target is already
    EEXIST. What the kernel cannot give is GNU's *wording*, because it
    reports the whole path where ``mkdir -p`` names the component it
    tripped on. So the chain is walked here, only once the op is known to
    have failed, and only to attribute the failure.

    Returns None when the walk finds nothing to blame, which leaves the
    caller free to re-raise the original errno: a failure this cannot
    explain (a permission gap, say) must still surface.

    Args:
        root (Path): The mount's host root.
        spec (PathSpec): The operand, used for its mount prefix.
        key (str): Normalized target key.
    """
    for component in ancestors(key):
        if await aio_path.isfile(_resolve(root, component)):
            return enotdir(mounted_path(spec, component))
    return None

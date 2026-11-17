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

from datetime import datetime

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.utils import checked, remote
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


def attrs_command(
    target: str,
    mode: int | None,
    uid: int | str | None,
    gid: int | str | None,
    atime: str | None,
    mtime: str | None,
) -> str | None:
    """The line that sets a file's mode, owners and times on a machine,
    None when nothing is asked.

    Args:
        target (str): the file's path on the machine.
        mode (int | None): permission bits.
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.
    """
    q = single_quote(target)
    steps: list[str] = []
    if mode is not None:
        steps.append(f"chmod {mode:o} -- {q}")
    if uid is not None:
        owner = single_quote(f"{uid}" if gid is None else f"{uid}:{gid}")
        steps.append(f"chown {owner} -- {q}")
    elif gid is not None:
        steps.append(f"chgrp {single_quote(str(gid))} -- {q}")
    for flag, when in (("-a", atime), ("-m", mtime)):
        if when is not None:
            stamp = datetime.fromisoformat(when).timestamp()
            steps.append(f"touch -c {flag} -d @{stamp} -- {q}")
    return " && ".join(steps) or None


async def set_attrs(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Set a file's metadata on its machine, all of it there: a machine's
    own programs read the same file, so nothing is left to an overlay.

    Returns:
        dict[str, int | str]: the fields the file does not hold, none.
    """
    command = attrs_command(
        remote(accessor, path), mode, uid, gid, atime, mtime
    )
    if command is not None:
        await checked(accessor, machine, command, path)
    return {}

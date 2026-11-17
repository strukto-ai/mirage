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

from mirage.core.posix.constants import SUMS
from mirage.core.posix.types import RunFn
from mirage.utils.quote import single_quote


async def checksum(run: RunFn, remote: str, algorithm: str) -> str | None:
    """A file's digest, by the matching coreutils sum where it is, so the
    bytes never travel.

    Only an exit of 0 with nothing on stderr and one digest of the
    algorithm's length on stdout answers: a host that runs no commands or
    has no such tool, a directory or a file the tool could not read
    leaves the file to be read and hashed, which reports it.

    Args:
        run (RunFn): runs a line where the file is.
        remote (str): the file's path there.
        algorithm (str): the hashlib name asked for.
    """
    tool = SUMS.get(algorithm)
    if tool is None:
        return None
    name, width = tool
    status, out, err = await run(f"{name} < {single_quote(remote)}")
    digest = out[:width].decode("ascii", "replace")
    if (
        status != 0
        or err
        or out[width:] != b"  -\n"
        or len(digest) != width
        or digest.strip("0123456789abcdef")
    ):
        return None
    return digest

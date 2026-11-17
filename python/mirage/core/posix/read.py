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

from mirage.core.posix.constants import WC
from mirage.core.posix.types import RunFn
from mirage.utils.quote import single_quote


async def line_count(run: RunFn, remote: str) -> int | None:
    """How many newlines a file holds, by wc where it is.

    Only an exit of 0 with nothing on stderr and one count on stdout
    answers: a host that runs no commands, a directory or a file wc could
    not read leaves the file to be read, which reports it.

    Args:
        run (RunFn): runs a line where the file is.
        remote (str): the file's path there.
    """
    status, out, err = await run(f"{WC} < {single_quote(remote)}")
    count = out.strip()
    if status != 0 or err or not out.endswith(b"\n") or not count.isdigit():
        return None
    return int(count)

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

from mirage.core.posix.constants import GREP
from mirage.core.posix.types import RunFn
from mirage.core.posix.utils import join_root
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)


def grep_command(text: str, scopes: list[str], ignore_case: bool) -> str:
    """The grep that lists the files under ``scopes`` holding ``text``.

    Args:
        text (str): the plain text.
        scopes (list[str]): the directories, where the files are.
        ignore_case (bool): fold ASCII case.
    """
    words = [GREP, *(["-i"] if ignore_case else []), "-e", single_quote(text)]
    return " ".join([*words, "--", *map(single_quote, scopes)])


async def files_containing(
    run: RunFn,
    root: str,
    text: str,
    under: list[PathSpec],
    ignore_case: bool,
) -> list[PathSpec] | None:
    """The files under ``under`` whose bytes hold ``text``, as grep where
    they are finds them.

    The answer is exact, since every file is searched, so a whole word is
    asked as plain text: a file the word only sits inside is one more
    read. Only an exit of 0 or 1 with nothing on stderr, and output that
    is NUL-ended names, answers: a host that runs no commands (one forced
    to internal-sftp says so on stdout and exits 1), a grep that refuses
    an option (busybox exits 1 for one), or a file it could not read
    (which the walk then reports) leaves every file to be read.

    Args:
        run (RunFn): runs a line where the files are.
        root (str): the path there the mount is rooted at.
        text (str): the plain text.
        under (list[PathSpec]): the directories walked.
        ignore_case (bool): fold ASCII case, which is all the text needs.
    """
    scopes = [join_root(root, p.mount_path) for p in under]
    status, out, err = await run(grep_command(text, scopes, ignore_case))
    if status not in (0, 1) or err or (out and not out.endswith(b"\0")):
        return None
    base = root.rstrip("/")
    hits: list[PathSpec] = []
    for raw in out.split(b"\0")[:-1]:
        try:
            name = raw.decode()
        except UnicodeDecodeError as exc:
            logger.debug("grep names unread: %s", exc)
            return None
        if not name.startswith(base + "/"):
            return None
        hits.append(mounted_path(under[0], name[len(base) :]))
    return hits

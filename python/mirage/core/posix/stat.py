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

from mirage.core.posix.constants import FIND, TREE_FORMAT
from mirage.core.posix.types import TreeRow
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)


def tree_command(scope: str, depth: int | None = None) -> str:
    """The find that lists ``scope`` and what is below it, links
    followed, one ``TREE_FORMAT`` record per entry.

    Args:
        scope (str): the path where the files are.
        depth (int | None): how deep to list: 0 for the scope alone (a
            stat), 1 for its children too (a listing), None for all.
    """
    bound = "" if depth is None else f" -maxdepth {depth}"
    return (
        f"{FIND} {single_quote(scope)}{bound} "
        f"-printf {single_quote(TREE_FORMAT)}"
    )


def _milliseconds(stamp: str) -> int:
    """A ``%T@`` time, seconds with a fraction, in epoch milliseconds,
    rounded as ``ms_to_rfc3339`` rounds; exact, with no float between.

    Args:
        stamp (str): what find printed, such as ``1700000000.1234567890``.

    Raises:
        ValueError: the text is not such a time.
    """
    whole, _, fraction = stamp.partition(".")
    negative = whole.startswith("-")
    digits = whole[1:] if negative else whole
    if not digits.isdigit() or (fraction and not fraction.isdigit()):
        raise ValueError(f"not a time: {stamp!r}")
    nanoseconds = int(digits) * 1_000_000_000 + int((fraction + "0" * 9)[:9])
    if negative:
        nanoseconds = -nanoseconds
    return (nanoseconds + 500_000) // 1_000_000


def parse_tree(out: bytes) -> list[TreeRow] | None:
    """The records a ``tree_command`` printed, None when the output is not
    whole records.

    Args:
        out (bytes): find's output.
    """
    if not out.endswith(b"\0"):
        return None
    rows: list[TreeRow] = []
    for record in out.split(b"\0")[:-1]:
        try:
            kind, mode, size, mtime, atime, uid, gid, nlink, blocks, rel = (
                record.decode().split(" ", 9)
            )
            rows.append(
                TreeRow(
                    kind=kind,
                    mode=int(mode, 8),
                    size=int(size),
                    mtime=int(mtime.split(".")[0]),
                    atime=int(atime.split(".")[0]),
                    mtime_ms=_milliseconds(mtime),
                    atime_ms=_milliseconds(atime),
                    uid=int(uid),
                    gid=int(gid),
                    nlink=int(nlink),
                    blocks=int(blocks),
                    rel=rel,
                )
            )
        except (UnicodeDecodeError, ValueError) as exc:
            logger.debug("find record unread: %s", exc)
            return None
    return rows

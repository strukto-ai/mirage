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

from functools import partial

from mirage.core.google.constants import CORPUS
from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.scope import Scope, Slot
from mirage.types import ContentType
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length, sanitize_label

TITLE_MAX_CHARS = 100
DATE_LEN = 10

sanitize_title = partial(
    sanitize_label, fallback="Untitled", max_len=TITLE_MAX_CHARS
)


def app_scopes(file_name: Codec) -> tuple[Scope, ...]:
    """The tree of a Google app mount: its corpora and their files.

    One description per app: readdir, stat, read and unlink all classify
    through it, so the file surface and the write surface cannot disagree
    about what a path means. Sheets, Docs and Slides differ only in the
    pattern a file name matches.

    Args:
        file_name (Codec): the codec of the app's file names.
    """
    return (
        Scope(kind="corpus", segments=(Slot("corpus", CORPUS),), probed=False),
        Scope(
            kind="file",
            segments=(
                Slot("corpus", CORPUS),
                Slot("name", file_name, id_key="file_id"),
            ),
            leaf=True,
            filetype=ContentType.JSON,
        ),
    )


def app_filename(
    title: str, file_id: str, modified_time: str = "", *, suffix: str
) -> str:
    """Build an app file's name from its title, id and modified date.

    The title takes whatever of the 255-byte NAME_MAX the date, the id and
    the suffix leave, rather than a flat character count: those are the same
    number only for ASCII, and a 100-character CJK title rendered a name ext4
    and APFS reject outright. The id never gives, so the name keeps
    addressing the file -- same rule as gcal's event filenames. Sheets, Docs
    and Slides differ only in the suffix.

    Args:
        title (str): raw file title.
        file_id (str): the Drive file ID.
        modified_time (str): ISO 8601 timestamp.
        suffix (str): the app's file suffix, e.g. ``.gdoc.json``.

    Returns:
        str: filename in format "YYYY-MM-DD_Sanitized_Title__id<suffix>".
    """
    lead = (
        f"{modified_time[:DATE_LEN]}_"
        if len(modified_time) >= DATE_LEN
        else ""
    )
    fixed = byte_length(lead) + len("__") + byte_length(file_id) + len(suffix)
    label = sanitize_title(title, max_bytes=NAME_MAX_BYTES - fixed)
    return f"{lead}{label}__{file_id}{suffix}"

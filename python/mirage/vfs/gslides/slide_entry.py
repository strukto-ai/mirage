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

from dataclasses import dataclass
from functools import partial

from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len, sanitize_label

TITLE_MAX_CHARS = 100
SUFFIX = ".gslide.json"
DATE_LEN = 10


@dataclass
class SlideEntry:
    id: str
    name: str
    modified_time: str
    created_time: str
    owner: str | None
    owned_by_me: bool
    can_edit: bool
    filename: str


sanitize_title = partial(sanitize_label,
                         fallback="Untitled",
                         max_len=TITLE_MAX_CHARS)


def make_filename(title: str, doc_id: str, modified_time: str = "") -> str:
    """Build a filename from title, doc ID, and modified date.

    The title takes whatever of the 255-byte NAME_MAX the date, the id and
    the suffix leave, rather than a flat character count: those are the same
    number only for ASCII, and a 100-character CJK title rendered a name ext4
    and APFS reject outright. The id never gives, so the name keeps
    addressing the document -- same rule as gcal's event filenames.

    Args:
        title (str): raw document title.
        doc_id (str): Google Slides presentation ID.
        modified_time (str): ISO 8601 timestamp.

    Returns:
        str: filename in format "YYYY-MM-DD_Sanitized_Title__docid.json".
    """
    lead = (f"{modified_time[:DATE_LEN]}_"
            if len(modified_time) >= DATE_LEN else "")
    fixed = byte_len(lead) + len("__") + byte_len(doc_id) + len(SUFFIX)
    label = sanitize_title(title, max_bytes=NAME_MAX_BYTES - fixed)
    return f"{lead}{label}__{doc_id}{SUFFIX}"

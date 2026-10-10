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

from mirage.core.hierarchy.codec import DATE, Codec
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType

GMAIL_JSON = Codec(suffix=".gmail.json")

_LABEL = (Slot("label"),)
_DAY = _LABEL + (Slot("day", DATE),)

# One description of the tree: readdir, stat, read and search all
# classify through it, so the file surface and the command surface
# cannot disagree about what a path means. The message scope is declared
# before the attachment dir because only the suffix separates the two at
# that depth.
SCOPES = (
    Scope(kind="label", segments=_LABEL),
    Scope(kind="day", segments=_DAY),
    Scope(
        kind="message",
        segments=_DAY + (Slot("message", GMAIL_JSON, id_key="message_id"),),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(
        kind="attachment_dir",
        segments=_DAY + (Slot("attachment_dir", id_key="message_id"),),
    ),
    Scope(
        kind="attachment",
        segments=_DAY
        + (Slot("attachment_dir", id_key="message_id"), Slot("filename")),
        leaf=True,
    ),
)

detect_scope = make_detect_scope(SCOPES)

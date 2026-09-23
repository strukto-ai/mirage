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

from mirage.core.gcal.day import valid_day
from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType
from mirage.vfs.gcal.event_entry import EVENT_SUFFIX


def is_event_name(text: str) -> bool:
    """Whether a segment is shaped like an event filename.

    Args:
        text (str): decoded segment payload.
    """
    return text.endswith(EVENT_SUFFIX)


# A calendar day is a real date, not merely date-shaped: 2026-02-30 must
# classify as invalid, or stat reports a directory every later call
# raises ValueError on.
DAY = Codec(validate=valid_day)
# The whole filename stays in the slot (no suffix strip): the id and the
# HHMM label are recovered by parse_event_filename, which needs the name
# as listed.
EVENT_NAME = Codec(validate=is_event_name)

_CAL = (Slot("calendar"), )
_DAY = _CAL + (Slot("day", DAY), )

# One description of the tree: readdir, stat, read and unlink all
# classify through it, so the file surface and the write surface cannot
# disagree about what a path means. The calendar level is a plain name
# ("primary", or `label__id`), proven against the calendar list rather
# than decoded.
SCOPES = (
    Scope(kind="calendar", segments=_CAL),
    Scope(kind="calendar_json",
          segments=_CAL + ("calendar.json", ),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="day", segments=_DAY),
    Scope(kind="event",
          segments=_DAY + (Slot("event", EVENT_NAME), ),
          leaf=True,
          filetype=ContentType.JSON),
)

detect_scope = make_detect_scope(SCOPES)

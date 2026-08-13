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

from mirage.utils.naming import make_id_name
from mirage.utils.sanitize import NAME_MAX_BYTES, sanitize_name, truncate_bytes

EVENT_SUFFIX = ".gcal.json"
CALENDAR_FILE = "calendar.json"
PRIMARY_DIR = "primary"
# "HHMM-HHMM"
HHMM_LEN = 9
UNTITLED = "untitled"
# A freeBusyReader calendar returns availability with no summary at all, so
# there is no title to sanitize and "busy" is the honest rendering.
BUSY = "busy"


def event_title(summary: str | None, *, free_busy: bool = False) -> str:
    """Pick the title segment for an event filename.

    Args:
        summary (str | None): the event's summary, absent when the calendar
            is only readable as free/busy.
        free_busy (bool): whether the calendar's accessRole hides details.

    Returns:
        str: a sanitized, non-empty title segment.
    """
    if summary is not None and summary.strip():
        return sanitize_name(summary)
    return BUSY if free_busy else UNTITLED


def make_event_filename(event_id: str, hhmm: str, title: str) -> str:
    """Build an event filename: id first, then the day-local times, then title.

    The id leads so that trimming the title can never make two events collide
    and so ``ls <idprefix>*`` addresses one event. Google event ids are 5-1024
    characters by spec (26 in practice), so the title takes whatever of the
    255-byte NAME_MAX is left rather than a fixed character count.

    Args:
        event_id (str): the Calendar API event id, embedded verbatim.
        hhmm (str): the day-clamped ``HHMM-HHMM`` label.
        title (str): an already-sanitized title segment.

    Returns:
        str: e.g. ``la9i1t9...__0900-1030_PhD_Defense.gcal.json``.
    """
    fixed = len(event_id.encode()) + len("__") + len(hhmm) + len("_") + len(
        EVENT_SUFFIX)
    trimmed = truncate_bytes(title, NAME_MAX_BYTES - fixed).rstrip("_")
    if not trimmed:
        # The title is what gives, never the id: trimming the id would make
        # the name stop addressing the event, which is the whole reason it
        # leads. An id long enough that even this form overflows NAME_MAX is
        # therefore unnameable rather than silently mangled. The spec permits
        # one (ids run 5-1024 chars) but only a caller-supplied id from
        # events.import can be that long; Google's own are 26.
        return f"{event_id}__{hhmm}{EVENT_SUFFIX}"
    return f"{event_id}__{hhmm}_{trimmed}{EVENT_SUFFIX}"


def parse_event_filename(name: str) -> tuple[str, str]:
    """Recover (event_id, hhmm) from an event filename.

    Splitting on the first ``__`` is safe because a Google event id is
    base32hex and can hold neither an underscore nor a separator, while a
    title routinely holds both.

    Args:
        name (str): the filename as rendered.

    Raises:
        FileNotFoundError: when the name is not an event filename.

    Returns:
        tuple[str, str]: the event id and the ``HHMM-HHMM`` label.
    """
    if not name.endswith(EVENT_SUFFIX):
        raise FileNotFoundError(name)
    raw = name[:-len(EVENT_SUFFIX)]
    event_id, sep, rest = raw.partition("__")
    if not sep or not event_id or len(rest) < HHMM_LEN:
        raise FileNotFoundError(name)
    return event_id, rest[:HHMM_LEN]


def make_calendar_dirname(summary: str,
                          calendar_id: str,
                          *,
                          primary: bool = False) -> str:
    """Build the directory name for one calendar.

    The primary calendar is spelled ``primary`` because that is the stable
    alias every Calendar API call accepts, and its summary is only the
    account's own email address.

    Args:
        summary (str): the calendar's title.
        calendar_id (str): the calendar id, embedded verbatim.
        primary (bool): whether this is the account's primary calendar.

    Returns:
        str: ``primary`` or ``Title__<calendarId>``.
    """
    if primary:
        return PRIMARY_DIR
    return make_id_name(summary, calendar_id)


def parse_calendar_dirname(name: str) -> str:
    """Recover the calendar id a directory name addresses.

    Args:
        name (str): the directory name as rendered.

    Raises:
        FileNotFoundError: when the name carries no calendar id.

    Returns:
        str: the calendar id, or ``primary`` for the primary alias.
    """
    if name == PRIMARY_DIR:
        return PRIMARY_DIR
    # rpartition, not partition: a calendar id holds "@" and "." but the
    # sanitized title before it may itself contain "__".
    _, sep, calendar_id = name.rpartition("__")
    if not sep or not calendar_id:
        raise FileNotFoundError(name)
    return calendar_id

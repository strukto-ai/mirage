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

import re

MULTI_UNDERSCORE = re.compile(r"_+")
MAX_LEN = 100
# POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
# characters is the same number only for ASCII: a 100-character CJK title is
# 300 bytes.
NAME_MAX_BYTES = 255
ELLIPSIS = "..."
# What ``/`` becomes inside a path segment: U+2215 DIVISION SLASH, the one
# character every backend renders a slash as, so a value cannot open a
# directory boundary. ``core.hierarchy.codec`` is what inverts it.
SAFE_SLASH = "∕"
# What marks the next character of a path segment as literal: U+2044
# FRACTION SLASH. ``path_safe_name`` leads a dot-led name with it, since the
# hierarchy hides a dot-led segment, and ``core.hierarchy.codec`` spells its
# reversible encoding with it.
ESCAPE_LEAD = "⁄"
# Unicode's White_Space property (PropList.txt), spelled out rather than
# read off ``str.strip``: Python also strips U+001C..U+001F, and
# JavaScript's ``trim`` strips U+FEFF but not U+0085, so a value blank in
# one runtime rendered a segment the other runtime spelled out.
WHITE_SPACE_CLASS = ("\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200a"
                     "\u2028\u2029\u202f\u205f\u3000")
WHITE_SPACE = re.compile(f"[{WHITE_SPACE_CLASS}]*")
# The same class, not ``\s``: python's ``\s`` takes U+001C..U+001F and
# JavaScript's takes U+FEFF, so one runtime kept a character the other
# replaced.
UNSAFE_CHARS = re.compile(f"[^\\w{WHITE_SPACE_CLASS}\\-.]")


def is_blank(text: str) -> bool:
    """Whether the text is empty or nothing but white space.

    Args:
        text (str): the string to test.

    Returns:
        bool: True when every character is Unicode White_Space.
    """
    return WHITE_SPACE.fullmatch(text) is not None


def byte_len(text: str) -> int:
    """Measure a string the way the filesystem does.

    Args:
        text (str): the string to measure.

    Returns:
        int: the length of ``text`` in UTF-8 bytes.
    """
    return len(text.encode("utf-8"))


def truncate_bytes(text: str, budget: int) -> str:
    """Trim a string to fit a byte budget without splitting a character.

    Args:
        text (str): the string to trim.
        budget (int): maximum length in UTF-8 bytes.

    Returns:
        str: ``text`` unchanged when it already fits, else the longest
        prefix whose UTF-8 encoding is at most ``budget`` bytes.
    """
    if budget <= 0:
        return ""
    raw = text.encode("utf-8")
    if len(raw) <= budget:
        return text
    # errors="ignore" drops the partial sequence the cut may have left,
    # which is exactly the trailing character that did not fit.
    return raw[:budget].decode("utf-8", errors="ignore")


def sanitize_name(name: str) -> str:
    """Sanitize a name for use in virtual paths.

    Replaces shell-unsafe characters (apostrophes, quotes, etc.)
    and spaces with underscores. Safe for use in shell commands
    without quoting.

    Args:
        name (str): raw name from API.

    Returns:
        str: sanitized name.
    """
    if is_blank(name):
        return "unknown"
    cleaned = UNSAFE_CHARS.sub("_", name)
    cleaned = cleaned.replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned)
    cleaned = cleaned.strip("_")
    if len(cleaned) > MAX_LEN:
        cleaned = cleaned[:MAX_LEN]
    return cleaned


def path_safe_name(name: str) -> str:
    """Make a name safe to embed in a VFS path segment.

    Preserves the original spelling (spaces, apostrophes, emoji, etc.)
    and only replaces the path separator ``/`` with ``SAFE_SLASH``
    (``∕``, U+2215), so the value cannot collide with a directory
    boundary, and leads a name that starts with ``.`` with
    ``ESCAPE_LEAD`` (``⁄``, U+2044), since the hierarchy classifies a
    dot-led segment as hidden: it would be dropped from every listing
    and refused as a path. Use this for VFS directory and file
    names where keeping the original display name matters more than
    shell ergonomics.

    Args:
        name (str): raw name from API.

    Returns:
        str: path-safe name, or "unknown" if empty.
    """
    if is_blank(name):
        return "unknown"
    safe = name.replace("/", SAFE_SLASH)
    if safe.startswith("."):
        return ESCAPE_LEAD + safe
    return safe


def sanitize_label(text: str,
                   *,
                   fallback: str,
                   max_len: int,
                   max_bytes: int = NAME_MAX_BYTES) -> str:
    """Sanitize an API-supplied label for use inside a filename.

    The shared body behind every backend's title/subject sanitizer:
    replace shell-unsafe characters and spaces with underscores, collapse
    the runs, trim the edges, then ellipsize past the budget. Backends
    differ only in what an empty label becomes and how long a label may
    be, so those are the arguments.

    Unlike ``sanitize_name`` this ellipsizes rather than hard-cutting, so
    a truncated name reads as truncated.

    Two budgets apply, and both have to: ``max_len`` is the readable
    length a backend wants, while ``max_bytes`` is what the filesystem
    will actually accept. They are the same number only for ASCII, so a
    100-character CJK title passed a 100-character budget untouched and
    rendered a 300-byte filename, which ext4 and APFS reject with
    ENAMETOOLONG. Pass the bytes the *rest* of the filename does not
    already use -- see ``make_filename`` in the gdocs/gsheets/gslides
    entries and ``make_event_filename`` in gcal, which is where the
    fixed overhead is known.

    Args:
        text (str): raw label from the API.
        fallback (str): what an empty or whitespace-only label becomes.
        max_len (int): budget in characters; a longer label keeps its
            first ``max_len - 3`` characters plus an ellipsis.
        max_bytes (int): budget in UTF-8 bytes for the label alone. A
            budget too small to hold even the ellipsis yields a bare
            truncation rather than three dots and nothing.

    Returns:
        str: the sanitized label.
    """
    if is_blank(text):
        return fallback
    cleaned = UNSAFE_CHARS.sub("_", text).replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned).strip("_")
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len - len(ELLIPSIS)] + ELLIPSIS
    if byte_len(cleaned) > max_bytes:
        head = truncate_bytes(cleaned, max(max_bytes - len(ELLIPSIS), 0))
        trimmed = head.rstrip("_.")
        if trimmed:
            cleaned = trimmed + ELLIPSIS
        else:
            cleaned = truncate_bytes(cleaned, max_bytes)
    return cleaned

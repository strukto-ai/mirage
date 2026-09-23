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

from mirage.utils.sanitize import (NAME_MAX_BYTES, byte_len, path_safe_name,
                                   sanitize_name, truncate_bytes)

SEPARATOR = "__"


def fit_id_name(label: str, resource_id: str, suffix: str = "") -> str:
    """Join an already-transformed label to its id inside NAME_MAX.

    The id and the suffix are what make the name *address* something, so
    they are spent first and never trimmed; the label takes whatever of the
    255 bytes is left. Trimming the id instead would leave a name that no
    longer resolves, and `parse_id_name` splits on the last separator, so a
    shortened label still round-trips.

    Budgets in bytes, not characters: ``sanitize_name`` caps at 100
    characters and ``path_safe_name`` does not cap at all, so a CJK display
    name reached 621 bytes against a 255-byte NAME_MAX and the filesystem
    refused the name outright.

    Takes the label already transformed because callers differ on the
    transform: most pass one name through ``sanitize_name``, while Linear's
    team directory joins two sanitized parts with the separator itself --
    re-sanitizing that would collapse ``__`` to ``_`` and change the name's
    shape.

    Args:
        label (str): the display half, already sanitized or path-escaped.
        resource_id (str): the id the name has to keep addressing.
        suffix (str): file extension, counted against the budget.

    Returns:
        str: ``<label>__<resource_id><suffix>``, at most NAME_MAX bytes
        unless the id alone cannot fit.
    """
    budget = NAME_MAX_BYTES - (len(SEPARATOR) + byte_len(resource_id) +
                               byte_len(suffix))
    if byte_len(label) > budget:
        label = truncate_bytes(label, budget).rstrip("_")
    return f"{label}{SEPARATOR}{resource_id}{suffix}"


def make_id_name(
    display_name: str,
    resource_id: str,
    *,
    path_safe: bool = False,
    suffix: str = "",
) -> str:
    """Build a name with embedded ID for VFS paths.

    Used by mounts that encode resource IDs in filenames
    for reverse lookups (Discord, Slack, gcal calendars, Linear, Trello).

    By default applies the full ``sanitize_name`` transform: replaces
    unsafe shell chars and spaces with underscores. Set
    ``path_safe=True`` to preserve the original spelling (apostrophes,
    spaces, emoji) and only replace ``/`` with ``∕``. Discord and
    Slack use ``path_safe=True`` so display names stay readable.

    Example::

        make_id_name("general", "C123456")
            → "general__C123456"
        make_id_name("My Project!", "uuid-abc")
            → "My_Project__uuid-abc"
        make_id_name("Zecheng's Server", "G1", path_safe=True)
            → "Zecheng's Server__G1"

    Args:
        display_name (str): human-readable name from the API.
        resource_id (str): VFS-specific unique ID.
        path_safe (bool): if True, preserve spelling and only escape
            the path separator. Otherwise apply full sanitization.
        suffix (str): file extension to append; pass it here rather than
            concatenating it afterwards, so it is counted against the
            NAME_MAX budget instead of pushing the name past it.
    """
    transform = path_safe_name if path_safe else sanitize_name
    return fit_id_name(transform(display_name), resource_id, suffix)


def parse_id_name(
    name: str,
    *,
    suffix: str = "",
) -> tuple[str, str]:
    """Extract (display_name, resource_id) from make_id_name output.

    Example::

        parse_id_name("general__C123456")
            → ("general", "C123456")
        parse_id_name("team__uuid.json", suffix=".json")
            → ("team", "uuid")

    Args:
        name (str): filename with embedded ID.
        suffix (str): file extension to strip before parsing.

    Raises:
        FileNotFoundError: if name doesn't contain "__" or doesn't end
            with ``suffix``.
    """
    if suffix and not name.endswith(suffix):
        raise FileNotFoundError(name)
    raw = name[:-len(suffix)] if suffix else name
    label, sep, resource_id = raw.rpartition("__")
    if not sep or not resource_id:
        raise FileNotFoundError(name)
    return label, resource_id

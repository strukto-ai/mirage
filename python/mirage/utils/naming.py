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

from mirage.utils.sanitize import path_safe_name, sanitize_name


def make_id_name(
    display_name: str,
    resource_id: str,
    *,
    path_safe: bool = False,
) -> str:
    """Build a name with embedded ID for VFS paths.

    Used by resources that encode resource IDs in filenames
    for reverse lookups (Discord, Slack, Linear, Trello).

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
        resource_id (str): resource-specific unique ID.
        path_safe (bool): if True, preserve spelling and only escape
            the path separator. Otherwise apply full sanitization.
    """
    transform = path_safe_name if path_safe else sanitize_name
    return f"{transform(display_name)}__{resource_id}"


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
        FileNotFoundError: if name doesn't contain "__".
    """
    raw = name[:-len(suffix)] if suffix else name
    label, sep, resource_id = raw.rpartition("__")
    if not sep or not resource_id:
        raise FileNotFoundError(name)
    return label, resource_id

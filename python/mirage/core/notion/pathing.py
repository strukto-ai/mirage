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


from mirage.utils.naming import fit_id_name
from mirage.utils.sanitize import sanitize_name


def format_segment(title: str, object_id: str) -> str:
    """Join a Notion object's title to its id inside the NAME_MAX budget.

    The one place the pair is composed, mirroring the TypeScript
    ``formatSegment``. Every dirname below and the child-page rows in
    ``readdir`` route through it so a title long enough to be trimmed is
    trimmed the same way everywhere -- a second spelling names a path that
    does not exist.

    Args:
        title (str): raw title, empty for an untitled object.
        object_id (str): Notion object id, never trimmed.

    Returns:
        str: dirname of shape ``<label>__<id>``.
    """
    return fit_id_name(
        sanitize_name(title) if title else "untitled", object_id
    )

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

import hashlib
from collections.abc import Mapping
from typing import Any

from mirage.core.hierarchy.codec import PATH_SAFE
from mirage.core.qdrant.payload import field_value
from mirage.core.render.json import value_text
from mirage.utils.naming import fit_id_name, parse_id_name
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len, path_safe_name
from mirage.vfs.qdrant.config import QdrantConfig


def group_name(value: Any, *, basename: bool = False) -> str:
    """Render one payload value as a VFS directory segment.

    A non-string value spells the way the point's ``.json`` spells it,
    so Python and TypeScript render one tree. Every level then renders
    through ``PATH_SAFE``, so the scope table decodes a segment back to
    the exact value it stands for. A basename level first drops the
    value's URL or path parents, which is lossy, so the lister resolves
    such a segment against the payload instead of decoding it. A leaf
    longer than NAME_MAX, which ext4 and APFS refuse, is cut to fit and
    keeps the md5 of the whole segment as its id, the ``<label>__<id>``
    shape every long name takes, so two leaves the cut would merge stay
    two directories.

    Args:
        value (Any): the raw payload value.
        basename (bool): render only the value's URL/path leaf.
    """
    name = value_text(value)
    if not basename:
        return PATH_SAFE.encode(name)
    without_query = name.split("#", 1)[0].split("?", 1)[0]
    trimmed = without_query.rstrip("/\\")
    leaf = trimmed.replace("\\", "/").rsplit("/", 1)[-1]
    segment = PATH_SAFE.encode(leaf or name)
    if byte_len(segment) <= NAME_MAX_BYTES:
        return segment
    return fit_id_name(segment,
                       hashlib.md5(segment.encode("utf-8")).hexdigest())


def row_stem(row: Mapping[str, Any], config: QdrantConfig) -> str:
    """Return the stable, human-readable stem for a point's files.

    Args:
        row (Mapping[str, Any]): point payload plus Mirage's synthetic fields.
        config (QdrantConfig): the mount's config.
    """
    # The point id is synthetic rather than payload data: _point_to_row stores
    # it under the configured key verbatim, even when that key contains dots.
    # Reading it through field_value would mistake a dotted id_field for a
    # nested payload path.
    point_id = str(row.get(config.id_field))
    label = field_value(row, config.name_field)
    if label is None:
        return point_id
    suffixes = [".json"]
    if config.text_field:
        suffixes.append(".txt")
    if config.blob_field:
        suffixes.append(f".{config.blob_ext}")
    longest_suffix = max(suffixes, key=byte_len)
    fitted = fit_id_name(path_safe_name(value_text(label)), point_id,
                         longest_suffix)
    return fitted[:-len(longest_suffix)]


def point_id_from_stem(stem: str, config: QdrantConfig) -> str:
    """Recover the opaque Qdrant point id from a VFS file stem.

    Args:
        stem (str): the file name without its suffix.
        config (QdrantConfig): the mount's config.
    """
    if not config.name_field:
        return stem
    try:
        _, point_id = parse_id_name(stem)
    except FileNotFoundError:
        # A point missing the optional naming payload still lists by id.
        return stem
    return point_id

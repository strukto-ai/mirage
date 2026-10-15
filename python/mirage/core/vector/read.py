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

import base64

from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.read import ReadFn
from mirage.core.hierarchy.read import make_read as hierarchy_read
from mirage.core.vector.types import VectorTree
from mirage.types import JsonValue, PathSpec


def blob_bytes(value: JsonValue) -> bytes:
    """A blob column's bytes, stored raw or as base64 text.

    Args:
        value (JsonValue): the column's value.
    """
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return base64.b64decode(value)
    raise ValueError("blob column is not bytes or base64 str")


def make_read(tree: VectorTree[A]) -> ReadFn:
    """Build a store's read over its per-kind readers.

    Args:
        tree (VectorTree[A]): the store's hooks.
    """

    def build(accessor: A) -> ReadFn:
        return hierarchy_read(tree.detect(accessor), tree.readers)

    read_for = per_accessor(build)

    async def read(accessor: A, path: PathSpec) -> bytes:
        return await read_for(accessor)(accessor, path)

    return read

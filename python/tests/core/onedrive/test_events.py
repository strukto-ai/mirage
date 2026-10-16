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

import pytest

from mirage.core.onedrive.events import build_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.registry import build_vfs
from tests.fixtures.msgraph_api import ME, FakeGraph, serve


def _accessor(graph: FakeGraph):
    return build_vfs(
        "onedrive", {"access_token": "t", "graph_base_url": graph.url}
    ).accessor


@pytest.mark.asyncio
async def test_the_feed_places_items_by_their_parents():
    with serve(FakeGraph(drives={ME: {"a.txt": b"one\n"}})) as graph:
        accessor = _accessor(graph)
        hook = build_delta_hook(accessor)
        root = PathSpec.from_str_path("/")
        try:
            baseline = await hook.pull(root, None)
            graph.write(ME, "sub/b.txt", b"two\n")
            graph.touch(ME, "a.txt")
            first = await hook.pull(root, baseline.checkpoint)
            graph.remove(ME, "a.txt")
            second = await hook.pull(root, first.checkpoint)
        finally:
            await accessor.close()
    assert baseline.changes == ()
    assert [(e.kind, e.path.virtual) for e in first.changes] == [
        (FileChangeKind.CREATE, "/sub"),
        (FileChangeKind.CREATE, "/sub/b.txt"),
        (FileChangeKind.UPDATE, "/a.txt"),
    ]
    assert [(e.kind, e.path.virtual) for e in second.changes] == [
        (FileChangeKind.DELETE, "/a.txt")
    ]

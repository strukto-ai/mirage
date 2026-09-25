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

from mirage.core.sharepoint.watch import build_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.registry import build_vfs
from mirage.watch.fingerprint import stat_fingerprint
from tests.fixtures.msgraph_api import (DRIVE_ID, DRIVE_NAME, SITE_NAME, FakeGraph,
                                        serve)

OLD = b"one\n"
NEW = b"two, longer\n"


def _accessor(graph: FakeGraph):
    return build_vfs("sharepoint", {
        "access_token": "t",
        "graph_base_url": graph.url,
        "site": SITE_NAME,
        "drive": DRIVE_NAME
    }).accessor


@pytest.mark.asyncio
async def test_a_metadata_edit_reports_nothing_and_a_write_reports_one_update():
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": OLD}})) as graph:
        accessor = _accessor(graph)
        hook = build_delta_hook(accessor)
        root = PathSpec.from_str_path("/")
        try:
            baseline = await hook.pull(root, None)
            # The walk stats each file from the listing it just made; that
            # row has to carry the cTag, or the fingerprint falls back to
            # the modified stamp, which a rename or property edit moves.
            graph.touch(DRIVE_ID, "a.txt")
            touched = await hook.pull(root, baseline.checkpoint)
            graph.write(DRIVE_ID, "a.txt", NEW)
            written = await hook.pull(root, touched.checkpoint)
        finally:
            await accessor.close()
    assert baseline.changes == ()
    assert touched.changes == ()
    assert [(e.kind, e.path.virtual) for e in written.changes] == [
        (FileChangeKind.UPDATE, "/a.txt")
    ]
    metadata = written.changes[0].metadata
    assert metadata is not None
    assert metadata.fingerprint == stat_fingerprint(
        graph.ctag(DRIVE_ID, "a.txt"), metadata.modified, len(NEW))

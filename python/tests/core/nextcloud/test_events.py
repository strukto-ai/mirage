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

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.events import NextcloudEventHook
from mirage.types import FileChangeKind, JsonValue, PathSpec
from mirage.vfs.nextcloud.config import NextcloudConfig

ROOT = PathSpec.from_str_path("/nc", vfs_path="")
NODE = "OCP\\Files\\Events\\Node\\"


def _hook(url: str, username: str | None = None) -> NextcloudEventHook:
    return NextcloudEventHook(
        NextcloudAccessor(NextcloudConfig(url=url, username=username))
    )


def _node(path: str) -> dict[str, JsonValue]:
    return {"event": {"node": {"path": path}}}


def _renamed(source: str, target: str) -> dict[str, JsonValue]:
    return {"event": {"source": {"path": source}, "target": {"path": target}}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url, username",
    [
        ("https://nc.test/remote.php/dav/files/ada/Work", None),
        ("https://nc.test/remote.php/webdav/Work/", "ada"),
    ],
)
async def test_node_events_map_below_the_mounted_folder(url, username):
    # The mount is rooted at the folder its URL names; a node outside it
    # maps nothing, and a rename across its edge is a create or a delete.
    hook = _hook(url, username)
    deliveries = [
        ("NodeCreatedEvent", _node("/ada/files/Work/a.txt")),
        ("NodeWrittenEvent", _node("/ada/files/Work/a.txt")),
        ("NodeDeletedEvent", _node("/ada/files/Work/sub")),
        ("NodeCreatedEvent", _node("/ada/files/Other/x.txt")),
        ("NodeCreatedEvent", _node("/bob/files/Work/x.txt")),
        (
            "NodeRenamedEvent",
            _renamed("/ada/files/Work/a.txt", "/ada/files/Work/b.txt"),
        ),
        (
            "NodeRenamedEvent",
            _renamed("/ada/files/Other/c.txt", "/ada/files/Work/c.txt"),
        ),
        (
            "NodeRenamedEvent",
            _renamed("/ada/files/Work/c.txt", "/ada/files/Other/c.txt"),
        ),
        ("NodeShareEvent", _node("/ada/files/Work/a.txt")),
    ]
    changes = [
        (event.kind, event.path.virtual, event.previous_path)
        for name, payload in deliveries
        for event in await hook.to_events(ROOT, NODE + name, payload)
    ]
    assert [(kind, path) for kind, path, _ in changes] == [
        (FileChangeKind.CREATE, "/nc/a.txt"),
        (FileChangeKind.UPDATE, "/nc/a.txt"),
        (FileChangeKind.DELETE, "/nc/sub"),
        (FileChangeKind.MOVE, "/nc/b.txt"),
        (FileChangeKind.CREATE, "/nc/c.txt"),
        (FileChangeKind.DELETE, "/nc/c.txt"),
    ]
    assert changes[3][2] is not None
    assert changes[3][2].virtual == "/nc/a.txt"


@pytest.mark.asyncio
async def test_a_folder_above_the_mount_root_moves_the_root():
    # Removing or renaming away a folder above the root removes the root;
    # one made or renamed into place leaves it unknown; its own writes say
    # nothing about the mount.
    hook = _hook("https://nc.test/remote.php/dav/files/ada/Projects/Work")
    deliveries = [
        ("NodeDeletedEvent", _node("/ada/files/Projects")),
        (
            "NodeRenamedEvent",
            _renamed("/ada/files/Projects", "/ada/files/Old"),
        ),
        (
            "NodeRenamedEvent",
            _renamed("/ada/files/New", "/ada/files/Projects"),
        ),
        ("NodeCreatedEvent", _node("/ada/files/Projects")),
        ("NodeWrittenEvent", _node("/ada/files/Projects")),
        ("NodeDeletedEvent", _node("/ada/files/Projects2")),
    ]
    changes = [
        (event.kind, event.path.virtual)
        for name, payload in deliveries
        for event in await hook.to_events(ROOT, NODE + name, payload)
    ]
    assert changes == [
        (FileChangeKind.DELETE, "/nc"),
        (FileChangeKind.DELETE, "/nc"),
        (FileChangeKind.UNKNOWN, "/nc"),
        (FileChangeKind.UNKNOWN, "/nc"),
    ]

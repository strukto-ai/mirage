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

from mirage.types import FileStat
from mirage.workspace.mount.namespace.namespace import NodeMeta
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat

BASE = FileStat(name="f.txt", size=3, modified="2026-01-01T00:00:00Z")


def test_none_meta_returns_stat_unchanged():
    assert merge_overlay_stat(None, BASE) is BASE


def test_empty_meta_returns_stat_unchanged():
    assert merge_overlay_stat(NodeMeta(), BASE) is BASE


def test_overlay_fields_win():
    meta = NodeMeta(mode=0o640, uid=7, gid=8)
    merged = merge_overlay_stat(meta, BASE)
    assert merged.mode == 0o640
    assert merged.uid == 7
    assert merged.gid == 8
    assert merged.size == 3
    assert merged.modified == "2026-01-01T00:00:00Z"


def test_mtime_overlays_modified():
    meta = NodeMeta(mtime=1767312000.0)
    merged = merge_overlay_stat(meta, BASE)
    assert merged.modified == "2026-01-02T00:00:00Z"


def test_link_mtime_does_not_touch_modified():
    meta = NodeMeta(target="/other", mtime=1767312000.0)
    merged = merge_overlay_stat(meta, BASE)
    assert merged.modified == "2026-01-01T00:00:00Z"

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

from mirage.vfs.gslides.gslides import VFS_MD


def test_vfs_md_includes_buckets_and_structure():
    rendered = VFS_MD.replace("{prefix}", "/gslides")
    assert "owned/" in rendered
    assert "shared/" in rendered
    assert "shared with you by others" in rendered
    assert "still in owned/" in rendered
    assert "gslide.json structure" in rendered
    text_path = (
        ".slides[].pageElements[].shape.text.textElements[].textRun.content"
    )
    assert text_path in rendered


def test_vfs_md_documents_rm_and_mv_for_a_write_path():
    assert "rm {prefix}/owned/<file>.gslide.json" in VFS_MD
    assert "mv {prefix}/owned/<date>_<old>__<id>.gslide.json" in VFS_MD
    assert "Delete, on a `write` path:" in VFS_MD
    assert "Rename to a new title, on a `write` path:" in VFS_MD

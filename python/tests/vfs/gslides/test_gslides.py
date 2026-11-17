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
    assert "stay in `owned/`" in rendered
    assert "`presentations.get`" in rendered
    assert "[.. | .textRun? // empty | .content] | add" in rendered


def test_vfs_md_documents_rm_and_mv_for_a_write_path():
    assert "On a `write` path, `rm` a file to delete it from Drive" in VFS_MD
    assert "`mv` it to a\n  new `<title>`" in VFS_MD

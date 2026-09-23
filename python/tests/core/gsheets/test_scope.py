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

from mirage.core.gsheets.scope import detect_scope
from mirage.types import PathSpec


def _ps(p: str) -> PathSpec:
    return PathSpec(virtual=p, directory=p, vfs_path=p.strip("/"))


def test_root():
    assert detect_scope(_ps("/")).kind == "root"


def test_corpus_dirs():
    for name in ("owned", "shared"):
        match = detect_scope(_ps(f"/{name}"))
        assert match.kind == "corpus"
        assert match.slots == {"corpus": name}


def test_file_splits_label_and_id():
    match = detect_scope(_ps("/owned/2024-01-05_Notes__abc12.gsheet.json"))
    assert match.kind == "file"
    assert match.slots == {
        "corpus": "owned",
        "name": "2024-01-05_Notes",
        "file_id": "abc12",
    }


def test_shared_file_matches_too():
    match = detect_scope(_ps("/shared/Plan__xyz.gsheet.json"))
    assert match.kind == "file"
    assert match.slots["file_id"] == "xyz"


def test_invalid_shapes():
    assert detect_scope(_ps("/bogus")).kind == "invalid"
    assert detect_scope(_ps("/bogus/File__id.gsheet.json")).kind == "invalid"
    assert detect_scope(_ps("/owned/plain.gsheet.json")).kind == "invalid"
    assert detect_scope(_ps("/owned/File__id.wrong.json")).kind == "invalid"
    assert detect_scope(
        _ps("/owned/File__id.gsheet.json/deep")).kind == "invalid"

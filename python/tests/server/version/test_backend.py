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

from pathlib import Path

from dulwich.objects import Blob

from mirage.server.version.backend import LocalBackend


def test_open_repo_creates_bare_repo_under_workspace_id(tmp_path: Path):
    backend = LocalBackend(tmp_path)
    backend.open_repo("ws1")
    assert (tmp_path / "ws1" / "objects").is_dir()
    assert (tmp_path / "ws1" / "HEAD").exists()


def test_open_repo_reuses_existing(tmp_path: Path):
    backend = LocalBackend(tmp_path)
    repo1 = backend.open_repo("ws1")
    blob = Blob.from_string(b"x")
    repo1.object_store.add_object(blob)
    repo2 = backend.open_repo("ws1")
    assert blob.id in repo2.object_store


def test_distinct_workspace_ids_are_isolated(tmp_path: Path):
    backend = LocalBackend(tmp_path)
    repo_a = backend.open_repo("a")
    repo_b = backend.open_repo("b")
    blob = Blob.from_string(b"only-in-a")
    repo_a.object_store.add_object(blob)
    assert blob.id in repo_a.object_store
    assert blob.id not in repo_b.object_store

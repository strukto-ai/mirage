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
from pydantic import ValidationError

from mirage.types import VFSName
from mirage.vfs.hf_datasets import HfDatasetsConfig, HfDatasetsVFS


def test_vfs_name():
    r = HfDatasetsVFS(HfDatasetsConfig(repo_id="org/dataset"))
    assert r.name == VFSName.HF_DATASETS
    assert r.caches_reads is True
    assert r.SUPPORTS_SNAPSHOT is True


def test_config_immutable():
    cfg = HfDatasetsConfig(repo_id="org/dataset")
    with pytest.raises(ValidationError):
        cfg.repo_id = "other/other"


def test_vfs_registers_ops():
    r = HfDatasetsVFS(HfDatasetsConfig(repo_id="org/dataset"))
    op_names = {o.name for o in r.ops_list()}
    assert {"read", "readdir", "stat"} <= op_names


def test_vfs_registers_no_mutation_ops():
    """A Hub mount is read-only; the `hf` CLI is what commits.

    The op table is the second of the two channels a write can arrive on,
    and it is the one a command bypasses: it answers `dispatch("write",
    ...)` and the FUSE adapter directly. Asserting the absence here is
    what keeps the two agreeing.
    """
    r = HfDatasetsVFS(HfDatasetsConfig(repo_id="org/dataset"))
    op_names = {o.name for o in r.ops_list()}
    assert not {"write", "create", "unlink", "rm_r", "mkdir"} & op_names


def test_vfs_registers_commands():
    r = HfDatasetsVFS(HfDatasetsConfig(repo_id="org/dataset"))
    cmd_names = {c.name for c in r.commands()}
    assert {"cat", "ls", "grep", "stat"} <= cmd_names
    assert not {"touch", "rm", "cp", "mv", "mkdir"} & cmd_names

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

from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource
from mirage.types import ResourceName


def test_resource_name():
    r = HfBucketsResource(HfBucketsConfig(bucket="o/b"))
    assert r.name == ResourceName.HF_BUCKETS
    assert r.caches_reads is True
    assert r.SUPPORTS_SNAPSHOT is True


def test_config_immutable():
    cfg = HfBucketsConfig(bucket="o/b")
    with pytest.raises(ValidationError):
        cfg.bucket = "other/other"


def test_resource_registers_ops():
    r = HfBucketsResource(HfBucketsConfig(bucket="o/b"))
    op_names = {o.name for o in r.ops_list()}
    assert {"read", "readdir", "stat", "write", "create", "unlink"} <= op_names


def test_resource_registers_commands():
    r = HfBucketsResource(HfBucketsConfig(bucket="o/b"))
    cmd_names = {c.name for c in r.commands()}
    assert {"cat", "ls", "grep", "stat", "touch", "rm"} <= cmd_names

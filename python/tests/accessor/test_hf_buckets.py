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

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from mirage.resource.secrets import reveal_secret


def test_config_defaults():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    assert cfg.bucket == "myorg/mybkt"
    assert cfg.namespace == "myorg"
    assert cfg.bucket_name == "mybkt"
    assert cfg.token is None
    assert cfg.endpoint == "https://huggingface.co"
    assert cfg.timeout == 30
    assert cfg.key_prefix is None


def test_config_immutable():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    with pytest.raises(Exception):
        cfg.bucket = "other/other"


def test_config_rejects_bad_bucket_format():
    with pytest.raises(ValueError):
        HfBucketsConfig(bucket="just-one-segment")
    with pytest.raises(ValueError):
        HfBucketsConfig(bucket="too/many/slashes")
    with pytest.raises(ValueError):
        HfBucketsConfig(bucket="/leading")


def test_config_token_secret():
    cfg = HfBucketsConfig(bucket="myorg/mybkt", token="hf_abc123")
    assert reveal_secret(cfg.token) == "hf_abc123"
    assert "hf_abc123" not in repr(cfg)


def test_accessor_holds_config():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    acc = HfBucketsAccessor(cfg)
    assert acc.config is cfg


def test_bucket_uri():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    acc = HfBucketsAccessor(cfg)
    assert acc.bucket_uri == "hf://buckets/myorg/mybkt"


def test_key_prefix_normalized():
    cfg = HfBucketsConfig(bucket="myorg/mybkt", key_prefix="/data/sub/")
    assert cfg.key_prefix == "data/sub/"

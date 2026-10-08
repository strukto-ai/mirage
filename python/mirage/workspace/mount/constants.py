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

from mirage.cache.types import WriteKind

_ALL: frozenset[WriteKind] = frozenset({"put", "copy", "delete"})

# The ops each backend conditions (docs/home/yaml.mdx, conditions.json).
WRITE_CONDITIONS: dict[str, frozenset[WriteKind]] = {
    "s3": _ALL,
    "seaweedfs": _ALL,
    "minio": frozenset({"put"}),
    "aliyun": _ALL,
    "backblaze": _ALL,
    "ceph": _ALL,
    "digitalocean": _ALL,
    "gcs": _ALL,
    "oci": _ALL,
    "qingstor": _ALL,
    "r2": _ALL,
    "scaleway": _ALL,
    "supabase": _ALL,
    "tencent": _ALL,
    "wasabi": _ALL,
}

# A custom `vfs: s3` endpoint may be MinIO, so it gets MinIO's row.
CUSTOM_ENDPOINT_CONDITIONS: frozenset[WriteKind] = WRITE_CONDITIONS["minio"]

# The domains AWS serves S3 from: the commercial partitions and China.
AWS_DOMAINS = ("amazonaws.com", "amazonaws.com.cn")

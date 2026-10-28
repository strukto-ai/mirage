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

SCOPE_ERROR = 5000
CONDITION_LOST_CODES = frozenset(
    {"412", "PreconditionFailed", "409", "ConditionalRequestConflict"}
)
DENIED_CODES = frozenset({"403", "AccessDenied"})

# A streamed upload's parts start at PART_SIZE and double every
# PART_DOUBLING parts, so an upload under 8 GiB sends the parts it always
# did and S3's 10,000 parts reach past its 5 TiB object cap; the last
# doubling (4 GiB) stays under its 5 GiB part cap.
PART_SIZE = 8 * 1024 * 1024
PART_DOUBLING = 1024
MAX_PARTS = 10000

# The stores whose ETag is an object's MD5 for a single-part upload kept
# unencrypted, so md5sum can take it instead of reading the object.
MD5_ETAG_STORES = frozenset(
    {"s3", "r2", "gcs", "minio", "ceph", "digitalocean", "wasabi"}
)

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

import re

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.client import (
    _key,
    create_s3_client,
    is_denied,
    is_not_found,
)
from mirage.core.s3.read import _fp_rev_from_s3_response
from mirage.errors.fs import eacces, enoent
from mirage.observe.context import record, revision_for, start_op
from mirage.types import PathSpec

# An MD5 as an ETag spells it: 32 lowercase hex digits, no part count.
MD5_ETAG = re.compile(r"[0-9a-f]{32}")


async def checksum(
    accessor: S3Accessor,
    path_spec: PathSpec,
    algorithm: str,
    aws: bool,
) -> str | None:
    """An object's MD5, read off its ETag when the ETag is one.

    A store names an object's MD5 as its ETag only for a single-part
    upload kept unencrypted, or on AWS under SSE-S3: a multipart ETag
    ends in ``-N``, and an object under SSE-KMS or SSE-C carries some
    other 32 hex digits, which no look at the ETag tells apart, so the
    head's encryption decides. Every other algorithm is None. A digest
    answered is recorded as the read it stands in for, with the ETag and
    version the head saw, so a snapshot pins them and a conditional
    write later in the line is conditioned on them.

    Args:
        accessor (S3Accessor): S3 accessor.
        path_spec (PathSpec): the object.
        algorithm (str): the hashlib name asked for.
        aws (bool): the store is AWS itself, where SSE-S3 keeps the MD5.
    """
    if algorithm != "md5":
        return None
    virtual = path_spec.virtual
    config = accessor.config
    kwargs = {
        "Bucket": config.bucket,
        "Key": _key(path_spec.mount_path, config),
    }
    pinned = revision_for(virtual)
    if pinned is not None:
        kwargs["VersionId"] = pinned
    client = await accessor.cached_client(lambda: create_s3_client(config))
    timer = start_op()
    try:
        resp = await client.head_object(**kwargs)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(virtual) from exc
        if is_denied(exc):
            raise eacces(virtual) from exc
        raise
    sse = resp.get("ServerSideEncryption")
    if resp.get("SSECustomerAlgorithm") or (
        sse and not (aws and sse == "AES256")
    ):
        return None
    etag = str(resp.get("ETag") or "").strip('"')
    if not MD5_ETAG.fullmatch(etag):
        return None
    fingerprint, revision = _fp_rev_from_s3_response(resp)
    record(
        "read",
        virtual,
        "s3",
        0,
        timer,
        fingerprint=fingerprint,
        revision=revision,
    )
    return etag

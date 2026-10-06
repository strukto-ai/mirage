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

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Any

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.s3.client import (
    _client_kwargs,
    _key,
    async_session,
    is_not_found,
)
from mirage.core.s3.read import _fp_rev_from_s3_response
from mirage.errors.fs import enoent
from mirage.observe.context import record_stream, revision_for
from mirage.types import PathSpec


async def read_stream(
    accessor: S3Accessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    """Async generator yielding chunks of an S3 object.

    Args:
        accessor (S3Accessor): S3 accessor.
        path_spec (PathSpec): Object path.
        index: Index cache store.
        chunk_size (int): Size of each chunk in bytes.
    """
    virtual = path_spec.virtual
    path = path_spec.mount_path
    pinned_revision = revision_for(virtual)
    config = accessor.config
    rec = record_stream("read", virtual, "s3")
    # The accessor's cached client, not a fresh one. It outlives this
    # generator, which is what a stream needs: the body is consumed after
    # the call that produced it returns.
    client = await accessor.cached_client(
        lambda: async_session(config).client(**_client_kwargs(config))
    )
    kwargs: dict[str, Any] = {
        "Bucket": config.bucket,
        "Key": _key(path, config),
    }
    if pinned_revision is not None:
        kwargs["VersionId"] = pinned_revision
    try:
        response = await client.get_object(**kwargs)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(virtual) from exc
        raise
    if rec is not None:
        fingerprint, revision = _fp_rev_from_s3_response(response)
        rec.fingerprint = fingerprint
        rec.revision = revision
    body = response["Body"]
    async with AsyncExitStack() as stack:
        if hasattr(body, "__aenter__") and hasattr(body, "__aexit__"):
            await stack.enter_async_context(body)
        else:
            close = getattr(body, "close", None)
            if close is not None:
                stack.callback(close)
        async for chunk in body.iter_chunks(chunk_size):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk

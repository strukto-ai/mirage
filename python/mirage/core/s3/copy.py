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

from mirage.accessor.s3 import S3Accessor
from mirage.core.object_store.copy import make_copy, settle_copy
from mirage.core.s3.client import (
    _key,
    create_s3_client,
    is_not_found,
)
from mirage.core.s3.driver import DRIVER
from mirage.core.s3.exists import exists
from mirage.errors.fs import enoent, exdev
from mirage.observe.context import start_op
from mirage.types import PathSpec
from mirage.vfs.s3.config import S3Config
from mirage.vfs.secrets import reveal_secret

copy = make_copy(DRIVER, exists)


def _service(config: S3Config) -> tuple[str | None, ...]:
    """Where a mount's requests go and who sends them.

    Args:
        config (S3Config): the mount's config.
    """
    return (
        config.endpoint_url,
        config.region,
        config.aws_profile,
        reveal_secret(config.aws_access_key_id),
        reveal_secret(config.aws_secret_access_key),
        reveal_secret(config.aws_session_token),
    )


async def copy_from(
    accessor: S3Accessor,
    source: S3Accessor,
    src: PathSpec,
    dst: PathSpec,
) -> None:
    """Copy an object from another S3 mount's bucket into this one's, in
    S3.

    One CopyObject, sent with this mount's client. S3 copies across
    buckets when one set of credentials reaches both, so it is tried
    only when both mounts send their requests to the same endpoint with
    the same credentials; otherwise, or when S3 refuses it, it is EXDEV,
    and the caller moves the bytes. A missing source is ENOENT.

    Args:
        accessor (S3Accessor): this mount's accessor.
        source (S3Accessor): the source mount's accessor.
        src (PathSpec): the object, on the source mount.
        dst (PathSpec): the copy, on this mount.
    """
    config = accessor.config
    if _service(config) != _service(source.config):
        raise exdev(dst)
    client = await accessor.cached_client(lambda: create_s3_client(config))
    timer = start_op()
    try:
        await client.copy_object(
            Bucket=config.bucket,
            Key=_key(dst.mount_path, config),
            CopySource={
                "Bucket": source.config.bucket,
                "Key": _key(src.mount_path, source.config),
            },
        )
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(src) from exc
        if hasattr(exc, "response"):
            raise exdev(dst) from exc
        raise
    await settle_copy(dst, DRIVER.vfs, timer)

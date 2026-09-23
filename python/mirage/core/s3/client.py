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
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import aioboto3
from botocore.config import Config

from mirage.accessor.s3 import S3Config
from mirage.utils import key_prefix as kp
from mirage.vfs.secrets import reveal_secret


def is_not_found(exc: Exception) -> bool:
    """Whether an S3 error means the key is absent.

    Args:
        exc (Exception): Error raised by a botocore call.
    """
    if hasattr(exc, "response"):
        code = exc.response.get("Error", {}).get("Code")
        return code in ("404", "NoSuchKey")
    return False


def _key(path: str, config: S3Config) -> str:
    return kp.apply(config.key_prefix or "", path)


def _prefix(path: str, config: S3Config) -> str:
    return kp.apply_dir(config.key_prefix or "", path)


def _strip_prefix(key: str, config: S3Config) -> str:
    return kp.strip(config.key_prefix or "", key)


def _client_kwargs(config: S3Config) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"service_name": "s3"}
    if config.region:
        kwargs["region_name"] = config.region
    if config.endpoint_url:
        kwargs["endpoint_url"] = config.endpoint_url
    access_key_id = reveal_secret(config.aws_access_key_id)
    secret_access_key = reveal_secret(config.aws_secret_access_key)
    session_token = reveal_secret(config.aws_session_token)
    proxy = reveal_secret(config.proxy)
    if access_key_id and secret_access_key:
        kwargs["aws_access_key_id"] = access_key_id
        kwargs["aws_secret_access_key"] = secret_access_key
    if session_token:
        kwargs["aws_session_token"] = session_token
    cfg_kwargs: dict[str, Any] = {
        "connect_timeout": config.timeout,
        "read_timeout": config.timeout,
    }
    if proxy:
        cfg_kwargs["proxies"] = {"https": proxy, "http": proxy}
    if config.path_style:
        cfg_kwargs["s3"] = {"addressing_style": "path"}
    kwargs["config"] = Config(**cfg_kwargs)
    return kwargs


def async_session(config: S3Config) -> aioboto3.Session:
    return aioboto3.Session(profile_name=config.aws_profile or None)


@asynccontextmanager
async def closing_body(body: Any) -> AsyncIterator[Any]:
    """Yield a streaming body and release it however that body can be released.

    The client outlives a single operation now that it is cached on the
    accessor, so a read that raises or is cancelled before EOF no longer has
    its connection reclaimed by the client closing. Each caller has to hand
    the pool slot back itself, or a few transport failures exhaust the pool
    and every later operation blocks waiting for a connection.

    Args:
        body (Any): the response body, which may be an async context manager
            or may only offer a plain ``close``.

    Yields:
        Any: the same body, released on exit.
    """
    async with AsyncExitStack() as stack:
        if hasattr(body, "__aenter__") and hasattr(body, "__aexit__"):
            await stack.enter_async_context(body)
        else:
            close = getattr(body, "close", None)
            if close is not None:
                stack.callback(close)
        yield body

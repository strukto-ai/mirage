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

import json
from typing import Any

import aioboto3
from pydantic import SecretStr

from mirage.secrets.config import AWSSMConfig
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret


def _reveal(value: SecretStr | None) -> str | None:
    return value.get_secret_value() if value is not None else None


def aws_session(config: AWSSMConfig) -> aioboto3.Session:
    """Build the aioboto3 session, honoring a configured profile.

    Module-level so a test can monkeypatch it with a stub session; the
    same split ``mirage.core.s3.client.async_session`` makes.

    Args:
        config (AWSSMConfig): the source's auth settings.
    """
    return aioboto3.Session(profile_name=config.aws_profile or None)


def _client_kwargs(config: AWSSMConfig) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"service_name": "secretsmanager"}
    if config.region:
        kwargs["region_name"] = config.region
    access_key_id = _reveal(config.aws_access_key_id)
    secret_access_key = _reveal(config.aws_secret_access_key)
    session_token = _reveal(config.aws_session_token)
    if access_key_id and secret_access_key:
        kwargs["aws_access_key_id"] = access_key_id
        kwargs["aws_secret_access_key"] = secret_access_key
    if session_token:
        kwargs["aws_session_token"] = session_token
    return kwargs


def fields_from_secret_string(text: str) -> dict[str, str]:
    """Shape one ``SecretString`` into secret fields.

    A JSON object with all-string values is the fields as-is (the
    common Secrets Manager layout); anything else -- a plain string, a
    JSON list, an object with non-string values -- is the whole text
    under ``value``.

    Args:
        text (str): the raw ``SecretString``.

    Returns:
        dict[str, str]: the secret's fields.
    """
    try:
        decoded = json.loads(text)
    except ValueError:
        return {"value": text}
    if isinstance(decoded, dict) and all(
            isinstance(value, str) for value in decoded.values()):
        return decoded
    return {"value": text}


async def fetch_aws_sm(config: AWSSMConfig, ref: str) -> ResolvedSecret:
    """Fetch one secret from AWS Secrets Manager.

    Args:
        config (AWSSMConfig): auth settings for the aioboto3 session.
        ref (str): the ``SecretId`` -- a secret name or full ARN.

    Returns:
        ResolvedSecret: the secret's fields.

    Raises:
        SecretsError: an empty ref, or a binary secret (v1 reads
            ``SecretString`` only).
    """
    if not ref:
        raise SecretsError(
            "the 'aws-sm' source needs a ref: the SecretId (name or ARN)")
    session = aws_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        response = await client.get_secret_value(SecretId=ref)
    text = response.get("SecretString")
    if text is None:
        raise SecretsError(f"secret {ref!r} is binary (SecretBinary); "
                           "v1 reads SecretString only")
    return ResolvedSecret(fields=fields_from_secret_string(text))

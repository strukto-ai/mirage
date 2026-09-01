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

import logging
from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from mirage.secrets.config import SecretRef, SourceBlock
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import fetch_secret, source_for
from mirage.secrets.summary import field_summary
from mirage.secrets.types import ResolvedSecret, ResolvedSource

logger = logging.getLogger(__name__)


async def config_value(name: str, field: str, ref: SecretRef,
                       fetched: dict[tuple[str, str], ResolvedSecret]) -> str:
    """Read one source-config value from its bootstrap source.

    Args:
        name (str): the instance being built, for the error.
        field (str): the config field being filled, for the error.
        ref (SecretRef): the pointer the field declared.

    Raises:
        SecretsError: the bootstrap source could not answer, or has no
            such field. Both wordings name the instance, the field and
            the source, and nothing else -- the same boundary
            ``fill_env`` draws, and for the same reason: a dotenv miss
            renders the host path it looked for, and a custom source
            shadowing ``env`` renders whatever it likes. The source's
            own words go to the host log instead.
    """
    seen = fetched.get((ref.provider, ref.ref))
    if seen is not None:
        return _field(name, field, ref, seen)
    try:
        secret = await fetch_secret(ref.provider, ref.ref)
    except Exception as exc:
        logger.warning("secrets.%s.config.%s: fetch from %s failed: %s", name,
                       field, ref.provider, exc)
        raise SecretsError(f"secrets.{name}.config.{field}: cannot fetch "
                           f"from {ref.provider}") from exc
    fetched[(ref.provider, ref.ref)] = secret
    return _field(name, field, ref, secret)


def _field(name: str, field: str, ref: SecretRef,
           secret: ResolvedSecret) -> str:
    value = secret.fields.get(ref.key)
    if value is None:
        raise SecretsError(f"secrets.{name}.config.{field}: wanted field "
                           f"{ref.key!r}, the {ref.provider} secret has "
                           f"{field_summary(secret.fields, ref.provider)}")
    return value


async def resolve_sources(
        blocks: Mapping[str, SourceBlock]) -> dict[str, ResolvedSource]:
    """Build every declared instance, reading its pointers.

    Runs once per workspace, before the first fetch, and reaches only
    bootstrap sources -- the process env and dotenv files -- so a
    declaration this cannot satisfy is a config error and fails every
    line, while a source that is merely unreachable still fails only
    the names that want it.

    Args:
        blocks (Mapping[str, SourceBlock]): the `secrets:` block,
            instance name -> declaration.

    Raises:
        SecretsError: an unknown source, a missing bootstrap field, or
            config the source's own model refuses. A refusal is
            reported by field and reason only; the values are never in
            the message.
    """
    out: dict[str, ResolvedSource] = {}
    # One fetch per bootstrap secret for the whole resolution: two
    # fields of one config naming the same dotenv file must read one
    # generation of it, or a rotation between them pins a mismatched
    # pair for the workspace's life.
    fetched: dict[tuple[str, str], ResolvedSecret] = {}
    for name, block in blocks.items():
        config_model, fetch = source_for(block.source)
        values: dict[str, Any] = {}
        for field, value in block.config.items():
            values[field] = (await config_value(name, field, value, fetched)
                             if isinstance(value, SecretRef) else value)
        try:
            config = config_model.model_validate(values)
        except ValidationError as exc:
            logger.warning("secrets.%s: config refused: %s", name, exc)
            # The error TYPE, never pydantic's rendered message: a
            # custom source's own validator may spell the rejected
            # input, and `values` is where a fetched credential has
            # just landed. The field path and the code say what is
            # wrong; the words go to the host log.
            detail = "; ".join(
                f"{'.'.join(str(part) for part in err['loc'])}: {err['type']}"
                for err in exc.errors())
            raise SecretsError(f"secrets.{name}: {detail}") from exc
        except Exception as exc:
            # A validator that RAISES rather than returning a
            # validation error never becomes an issue list, and
            # pydantic only wraps ValueError and AssertionError. The
            # words are the validator's, over a value just fetched.
            logger.warning("secrets.%s: config validation raised: %s", name,
                           exc)
            raise SecretsError(f"secrets.{name}: config refused") from exc
        out[name] = ResolvedSource(block.source, config, fetch)
    return out

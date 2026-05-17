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
from typing import Any

import jwt as pyjwt

from mirage.server.auth.config import JWTConfig

logger = logging.getLogger(__name__)


class JWTVerificationError(Exception):
    pass


def verify_jwt(token: str, cfg: JWTConfig) -> dict[str, Any]:
    """Verify a JWT against ``cfg`` and return its claims on success.

    Performs signature verification, algorithm pinning, mandatory
    ``exp`` check, and (when configured) ``iss``/``aud``/``azp``
    checks. ``typ`` header, if present, must be ``"JWT"``.

    Args:
        token (str): the raw bearer value (already stripped of any
            ``Bearer `` prefix).
        cfg (JWTConfig): verification parameters.

    Returns:
        dict[str, Any]: validated claims.

    Raises:
        JWTVerificationError: any failure (signature, algorithm,
            ``exp``, ``iss``, ``aud``, ``azp``, ``typ``).
    """
    try:
        claims = pyjwt.decode(
            token,
            cfg.key,
            algorithms=[cfg.algorithm],
            audience=cfg.audience,
            issuer=cfg.issuer,
            options={"require": ["exp"]},
            leeway=cfg.clock_skew_seconds,
        )
    except pyjwt.PyJWTError as e:
        raise JWTVerificationError(f"JWT rejected: {e}") from e
    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError as e:
        raise JWTVerificationError(f"JWT header unreadable: {e}") from e
    typ = header.get("typ")
    if typ is not None and typ != "JWT":
        raise JWTVerificationError(
            f"JWT typ header must be 'JWT' when present, got {typ!r}")
    if cfg.authorized_parties:
        azp = claims.get("azp")
        if azp not in cfg.authorized_parties:
            raise JWTVerificationError(
                f"JWT azp {azp!r} not in authorized_parties")
    return claims

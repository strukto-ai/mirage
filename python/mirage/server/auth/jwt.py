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


def verify_jwt(
    token: str, cfg: JWTConfig, key: Any | None = None
) -> dict[str, Any]:
    """Verify a JWT against ``cfg`` and return its claims on success.

    Performs signature verification, algorithm pinning, mandatory
    ``exp`` and ``sub`` (the account the token speaks for) checks, and
    (when configured) an ``iss`` check. A token with ``aud`` must name
    one of the configured audiences; one without must carry an ``azp``
    in the authorized parties when any are configured, and is refused
    when only audiences are. So one server takes both an app's session
    tokens (``azp``, no ``aud``) and an OAuth client's access tokens
    (``aud``). ``typ`` header, if present, must be ``"JWT"``.

    Args:
        token (str): the raw bearer value (already stripped of any
            ``Bearer `` prefix).
        cfg (JWTConfig): verification parameters.
        key (Any | None): the key to check the signature with; None
            uses ``cfg.key``.

    Returns:
        dict[str, Any]: validated claims.

    Raises:
        JWTVerificationError: any failure (signature, algorithm,
            ``exp``, ``sub``, ``iss``, ``aud``, ``azp``, ``typ``).
    """
    chosen = key if key is not None else cfg.key
    if chosen is None:
        raise JWTVerificationError("no JWT key configured")
    try:
        claims = pyjwt.decode(
            token,
            chosen,
            algorithms=[cfg.algorithm],
            issuer=cfg.issuer,
            options={"require": ["exp", "sub"], "verify_aud": False},
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
            f"JWT typ header must be 'JWT' when present, got {typ!r}"
        )
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise JWTVerificationError("JWT sub must name an account")
    aud = claims.get("aud")
    if aud is not None:
        named = [aud] if isinstance(aud, str) else aud
        if not isinstance(named, list) or not any(
            a in cfg.audiences for a in named
        ):
            raise JWTVerificationError(f"JWT aud {aud!r} not in audiences")
    elif cfg.authorized_parties:
        azp = claims.get("azp")
        if azp not in cfg.authorized_parties:
            raise JWTVerificationError(
                f"JWT azp {azp!r} not in authorized_parties"
            )
    elif cfg.audiences:
        raise JWTVerificationError("JWT has no aud")
    return claims

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

import os
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Mapping

from mirage.server.auth import storage as _storage

ENV_AUTH_MODE = "MIRAGE_AUTH_MODE"
ENV_AUTH_TOKEN = "MIRAGE_AUTH_TOKEN"
ENV_JWT_PUBKEY = "MIRAGE_JWT_PUBKEY"
ENV_JWT_PUBKEY_FILE = "MIRAGE_JWT_PUBKEY_FILE"
ENV_JWT_ALG = "MIRAGE_JWT_ALG"
ENV_JWT_ISSUER = "MIRAGE_JWT_ISSUER"
ENV_JWT_AUDIENCE = "MIRAGE_JWT_AUDIENCE"
ENV_JWT_AUTHORIZED_PARTIES = "MIRAGE_JWT_AUTHORIZED_PARTIES"
ENV_JWT_CLOCK_SKEW = "MIRAGE_JWT_CLOCK_SKEW_SECONDS"

DEFAULT_CLOCK_SKEW_SECONDS = 5


class AuthMode(StrEnum):
    LOCAL = "local"
    TOKEN = "token"
    JWT = "jwt"


@dataclass(frozen=True)
class JWTConfig:
    key: str
    algorithm: str
    issuer: str | None = None
    audience: str | None = None
    authorized_parties: tuple[str, ...] = field(default_factory=tuple)
    clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_SECONDS


@dataclass(frozen=True)
class AuthConfig:
    mode: AuthMode
    local_token: str | None = None
    bearer_token: str | None = None
    jwt: JWTConfig | None = None


def resolve_local_token(
    env: Mapping[str, str] | None = None,
    token_file: Path | None = None,
) -> str | None:
    """Resolve the local-mode bearer token via env > file > None.

    Args:
        env (Mapping[str, str] | None): environment to read
            ``MIRAGE_AUTH_TOKEN`` from. Defaults to ``os.environ``.
        token_file (Path | None): location of the token file.
            Defaults to ``default_token_file()``.

    Returns:
        str | None: resolved token, or ``None`` if no source provides one.
    """
    e = env if env is not None else os.environ
    val = e.get(ENV_AUTH_TOKEN, "").strip()
    if val:
        return val
    path = (token_file
            if token_file is not None else _storage.default_token_file())
    return _storage.read_token_file(path)


def _read_jwt_key(env: Mapping[str, str]) -> str:
    inline = env.get(ENV_JWT_PUBKEY, "").strip()
    if inline:
        return inline
    path = env.get(ENV_JWT_PUBKEY_FILE, "").strip()
    if path:
        return Path(path).read_text()
    raise RuntimeError(
        f"mode=jwt requires {ENV_JWT_PUBKEY} or {ENV_JWT_PUBKEY_FILE}")


def _parse_csv(value: str) -> tuple[str, ...]:
    return tuple(p.strip() for p in value.split(",") if p.strip())


def resolve_auth_config(
    env: Mapping[str, str] | None = None,
    token_file: Path | None = None,
) -> AuthConfig:
    """Resolve daemon auth configuration from environment.

    Args:
        env (Mapping[str, str] | None): environment to read from.
            Defaults to ``os.environ``.
        token_file (Path | None): override the local-mode token file
            location. Defaults to ``default_token_file()``.

    Returns:
        AuthConfig: resolved configuration.

    Raises:
        RuntimeError: if required env vars are missing for the chosen mode.
    """
    e = env if env is not None else os.environ
    raw_mode = (e.get(ENV_AUTH_MODE, "")
                or AuthMode.LOCAL.value).strip().lower()
    try:
        mode = AuthMode(raw_mode)
    except ValueError as exc:
        valid = ", ".join(m.value for m in AuthMode)
        raise RuntimeError(
            f"{ENV_AUTH_MODE} must be one of ({valid}), got {raw_mode!r}"
        ) from exc

    if mode == AuthMode.LOCAL:
        return AuthConfig(
            mode=mode,
            local_token=resolve_local_token(env=e, token_file=token_file),
        )

    if mode == AuthMode.TOKEN:
        token = e.get(ENV_AUTH_TOKEN, "").strip()
        if not token:
            raise RuntimeError(
                f"mode=token requires {ENV_AUTH_TOKEN} to be set")
        return AuthConfig(mode=mode, bearer_token=token)

    key = _read_jwt_key(e)
    alg = e.get(ENV_JWT_ALG, "").strip()
    if not alg:
        raise RuntimeError(f"mode=jwt requires {ENV_JWT_ALG} (e.g. RS256)")
    issuer = (e.get(ENV_JWT_ISSUER) or "").strip() or None
    audience = (e.get(ENV_JWT_AUDIENCE) or "").strip() or None
    azp = _parse_csv(e.get(ENV_JWT_AUTHORIZED_PARTIES, ""))
    skew_raw = (e.get(ENV_JWT_CLOCK_SKEW) or "").strip()
    skew = int(skew_raw) if skew_raw else DEFAULT_CLOCK_SKEW_SECONDS
    return AuthConfig(
        mode=mode,
        jwt=JWTConfig(
            key=key,
            algorithm=alg,
            issuer=issuer,
            audience=audience,
            authorized_parties=azp,
            clock_skew_seconds=skew,
        ),
    )

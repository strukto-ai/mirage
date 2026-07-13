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
from mirage.server.daemon_config import read_daemon_table
from mirage.server.paths import mirage_home

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


_CONFIG_ENV_KEYS = {
    "auth_mode": ENV_AUTH_MODE,
    "jwt_alg": ENV_JWT_ALG,
    "jwt_issuer": ENV_JWT_ISSUER,
    "jwt_audience": ENV_JWT_AUDIENCE,
    "jwt_pubkey_file": ENV_JWT_PUBKEY_FILE,
    "jwt_clock_skew": ENV_JWT_CLOCK_SKEW,
    "jwt_authorized_parties": ENV_JWT_AUTHORIZED_PARTIES,
}


def _merge_config_table(env: Mapping[str, str],
                        table: Mapping[str, object]) -> dict[str, str]:
    """Fold config.toml auth keys under their env names, env winning.

    Only non-secret keys have config counterparts: the raw
    ``MIRAGE_AUTH_TOKEN`` and inline ``MIRAGE_JWT_PUBKEY`` stay
    env-only (use the token file / ``jwt_pubkey_file`` instead).

    Args:
        env (Mapping[str, str]): the process environment view.
        table (Mapping[str, object]): the ``[daemon]`` config table.

    Returns:
        dict[str, str]: env copy with config fallbacks applied.
    """
    merged = dict(env)
    for cfg_key, env_name in _CONFIG_ENV_KEYS.items():
        if merged.get(env_name, "").strip():
            continue
        value = table.get(cfg_key)
        if value is not None and str(value).strip():
            merged[env_name] = str(value)
    return merged


def resolve_auth_config(
    env: Mapping[str, str] | None = None,
    token_file: Path | None = None,
    table: Mapping[str, object] | None = None,
) -> AuthConfig:
    """Resolve daemon auth configuration from environment and config.

    Per key the environment variable wins over the ``[daemon]`` table
    in ``config.toml``, which wins over the default.

    Args:
        env (Mapping[str, str] | None): environment to read from.
            Defaults to ``os.environ``.
        token_file (Path | None): override the local-mode token file
            location. Defaults to ``default_token_file()``.
        table (Mapping[str, object] | None): the ``[daemon]`` config
            table. Defaults to reading ``$MIRAGE_HOME/config.toml``
            when ``env`` is also defaulted; an explicit ``env`` with no
            ``table`` stays hermetic and reads no file.

    Returns:
        AuthConfig: resolved configuration.

    Raises:
        RuntimeError: if required settings are missing for the chosen mode.
    """
    if table is None:
        table = read_daemon_table(mirage_home()) if env is None else {}
    e = _merge_config_table(env if env is not None else os.environ, table)
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

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

import pytest

from mirage.server.auth.config import (AuthMode, JWTConfig,
                                       resolve_auth_config,
                                       resolve_local_token)
from mirage.server.daemon_config import ALLOWED_KEYS


@pytest.mark.no_host_override
def test_resolve_local_token_env_wins(tmp_path):
    f = tmp_path / "auth_token"
    f.write_text("from-file")
    got = resolve_local_token(env={"MIRAGE_AUTH_TOKEN": "from-env"},
                              token_file=f)
    assert got == "from-env"


@pytest.mark.no_host_override
def test_resolve_local_token_falls_back_to_file(tmp_path):
    f = tmp_path / "auth_token"
    f.write_text("from-file")
    got = resolve_local_token(env={}, token_file=f)
    assert got == "from-file"


@pytest.mark.no_host_override
def test_resolve_local_token_returns_none_when_no_source(tmp_path):
    f = tmp_path / "missing"
    got = resolve_local_token(env={}, token_file=f)
    assert got is None


@pytest.mark.no_host_override
def test_resolve_auth_config_default_is_local_no_token(tmp_path):
    cfg = resolve_auth_config(env={}, token_file=tmp_path / "missing")
    assert cfg.mode == "local"
    assert cfg.local_token is None
    assert cfg.bearer_token is None
    assert cfg.jwt is None


@pytest.mark.no_host_override
def test_resolve_auth_config_local_with_env(tmp_path):
    cfg = resolve_auth_config(env={"MIRAGE_AUTH_TOKEN": "lt"},
                              token_file=tmp_path / "missing")
    assert cfg.mode == "local"
    assert cfg.local_token == "lt"


@pytest.mark.no_host_override
def test_resolve_auth_config_token_mode_requires_env(tmp_path):
    with pytest.raises(RuntimeError, match="MIRAGE_AUTH_TOKEN"):
        resolve_auth_config(env={"MIRAGE_AUTH_MODE": "token"},
                            token_file=tmp_path / "missing")


@pytest.mark.no_host_override
def test_resolve_auth_config_token_mode_uses_env_token(tmp_path):
    cfg = resolve_auth_config(env={
        "MIRAGE_AUTH_MODE": "token",
        "MIRAGE_AUTH_TOKEN": "operator-pat"
    },
                              token_file=tmp_path / "missing")
    assert cfg.mode == "token"
    assert cfg.bearer_token == "operator-pat"
    assert cfg.local_token is None
    assert cfg.jwt is None


@pytest.mark.no_host_override
def test_resolve_auth_config_jwt_mode_requires_key(tmp_path):
    with pytest.raises(RuntimeError, match="MIRAGE_JWT_PUBKEY"):
        resolve_auth_config(env={
            "MIRAGE_AUTH_MODE": "jwt",
            "MIRAGE_JWT_ALG": "RS256"
        },
                            token_file=tmp_path / "missing")


@pytest.mark.no_host_override
def test_resolve_auth_config_jwt_mode_requires_alg(tmp_path):
    with pytest.raises(RuntimeError, match="MIRAGE_JWT_ALG"):
        resolve_auth_config(env={
            "MIRAGE_AUTH_MODE": "jwt",
            "MIRAGE_JWT_PUBKEY": "-----BEGIN"
        },
                            token_file=tmp_path / "missing")


@pytest.mark.no_host_override
def test_resolve_auth_config_jwt_mode_inline_key(tmp_path):
    cfg = resolve_auth_config(env={
        "MIRAGE_AUTH_MODE": "jwt",
        "MIRAGE_JWT_PUBKEY":
        "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----",
        "MIRAGE_JWT_ALG": "RS256",
        "MIRAGE_JWT_ISSUER": "https://issuer.example",
        "MIRAGE_JWT_AUDIENCE": "mirage-daemon",
        "MIRAGE_JWT_AUTHORIZED_PARTIES":
        "https://app.example,https://other.example",
        "MIRAGE_JWT_CLOCK_SKEW_SECONDS": "12",
    },
                              token_file=tmp_path / "missing")
    assert cfg.mode == "jwt"
    assert cfg.jwt is not None
    assert isinstance(cfg.jwt, JWTConfig)
    assert "FAKE" in cfg.jwt.key
    assert cfg.jwt.algorithm == "RS256"
    assert cfg.jwt.issuer == "https://issuer.example"
    assert cfg.jwt.audience == "mirage-daemon"
    assert cfg.jwt.authorized_parties == ("https://app.example",
                                          "https://other.example")
    assert cfg.jwt.clock_skew_seconds == 12


@pytest.mark.no_host_override
def test_resolve_auth_config_jwt_mode_pubkey_from_file(tmp_path):
    key_file = tmp_path / "jwt.pub"
    key_file.write_text(
        "-----BEGIN PUBLIC KEY-----\nFROMFILE\n-----END PUBLIC KEY-----")
    cfg = resolve_auth_config(env={
        "MIRAGE_AUTH_MODE": "jwt",
        "MIRAGE_JWT_PUBKEY_FILE": str(key_file),
        "MIRAGE_JWT_ALG": "RS256",
    },
                              token_file=tmp_path / "missing")
    assert cfg.mode == "jwt"
    assert cfg.jwt is not None
    assert "FROMFILE" in cfg.jwt.key
    assert cfg.jwt.clock_skew_seconds == 5  # default mirrors Clerk


@pytest.mark.no_host_override
def test_resolve_auth_config_unknown_mode_raises(tmp_path):
    with pytest.raises(RuntimeError, match="MIRAGE_AUTH_MODE"):
        resolve_auth_config(env={"MIRAGE_AUTH_MODE": "wat"},
                            token_file=tmp_path / "missing")


def test_auth_mode_from_config_table(tmp_path):
    cfg = resolve_auth_config(env={"MIRAGE_AUTH_TOKEN": "tok"},
                              table={"auth_mode": "token"})
    assert cfg.mode == AuthMode.TOKEN
    assert cfg.bearer_token == "tok"


def test_env_auth_mode_beats_config_table(tmp_path):
    cfg = resolve_auth_config(env={"MIRAGE_AUTH_MODE": "local"},
                              token_file=tmp_path / "missing",
                              table={"auth_mode": "token"})
    assert cfg.mode == AuthMode.LOCAL


def test_jwt_settings_from_config_table(tmp_path):
    key_file = tmp_path / "pub.pem"
    key_file.write_text("KEYDATA")
    cfg = resolve_auth_config(env={},
                              table={
                                  "auth_mode": "jwt",
                                  "jwt_pubkey_file": str(key_file),
                                  "jwt_alg": "RS256",
                                  "jwt_issuer": "https://issuer",
                                  "jwt_audience": "aud",
                                  "jwt_authorized_parties": "a,b",
                                  "jwt_clock_skew": 9,
                              })
    assert cfg.mode == AuthMode.JWT
    assert cfg.jwt is not None
    assert cfg.jwt.key == "KEYDATA"
    assert cfg.jwt.algorithm == "RS256"
    assert cfg.jwt.issuer == "https://issuer"
    assert cfg.jwt.audience == "aud"
    assert cfg.jwt.authorized_parties == ("a", "b")
    assert cfg.jwt.clock_skew_seconds == 9


def test_env_jwt_alg_beats_config_table(tmp_path):
    key_file = tmp_path / "pub.pem"
    key_file.write_text("KEYDATA")
    cfg = resolve_auth_config(env={
        "MIRAGE_AUTH_MODE": "jwt",
        "MIRAGE_JWT_PUBKEY_FILE": str(key_file),
        "MIRAGE_JWT_ALG": "ES256",
    },
                              table={"jwt_alg": "RS256"})
    assert cfg.jwt is not None
    assert cfg.jwt.algorithm == "ES256"


def test_secret_keys_have_no_config_key():
    assert "jwt_pubkey" not in ALLOWED_KEYS
    assert "MIRAGE_AUTH_TOKEN" not in ALLOWED_KEYS
    assert "auth_mode" in ALLOWED_KEYS
    assert "jwt_alg" in ALLOWED_KEYS

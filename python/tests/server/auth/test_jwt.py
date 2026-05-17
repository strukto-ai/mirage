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

import time
from dataclasses import dataclass

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from mirage.server.auth.config import JWTConfig
from mirage.server.auth.jwt import JWTVerificationError, verify_jwt


@dataclass
class KeyPair:
    private_pem: bytes
    public_pem: bytes


@pytest.fixture(scope="module")
def rsa_keys() -> KeyPair:
    private_key = rsa.generate_private_key(public_exponent=65537,
                                           key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return KeyPair(private_pem=private_pem, public_pem=public_pem)


def _make_cfg(rsa_keys: KeyPair, **overrides) -> JWTConfig:
    base = dict(
        key=rsa_keys.public_pem.decode(),
        algorithm="RS256",
        issuer=None,
        audience=None,
        authorized_parties=(),
        clock_skew_seconds=5,
    )
    base.update(overrides)
    return JWTConfig(**base)


def _sign(rsa_keys: KeyPair,
          claims: dict,
          *,
          alg: str = "RS256",
          headers: dict | None = None) -> str:
    return pyjwt.encode(claims,
                        rsa_keys.private_pem,
                        algorithm=alg,
                        headers=headers)


@pytest.mark.no_host_override
def test_verify_jwt_accepts_valid_rs256(rsa_keys):
    cfg = _make_cfg(rsa_keys)
    token = _sign(rsa_keys, {"sub": "user-1", "exp": int(time.time()) + 60})
    claims = verify_jwt(token, cfg)
    assert claims["sub"] == "user-1"


@pytest.mark.no_host_override
def test_verify_jwt_rejects_alg_none(rsa_keys):
    cfg = _make_cfg(rsa_keys)
    token = pyjwt.encode({
        "sub": "x",
        "exp": int(time.time()) + 60
    },
                         key="",
                         algorithm="none")
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_rejects_alg_confusion(rsa_keys):
    cfg = _make_cfg(rsa_keys, algorithm="RS256")
    token = pyjwt.encode({
        "sub": "x",
        "exp": int(time.time()) + 60
    },
                         key="shared-secret",
                         algorithm="HS256")
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_rejects_missing_exp(rsa_keys):
    cfg = _make_cfg(rsa_keys)
    token = _sign(rsa_keys, {"sub": "x"})
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_rejects_expired(rsa_keys):
    cfg = _make_cfg(rsa_keys, clock_skew_seconds=0)
    token = _sign(rsa_keys, {"sub": "x", "exp": int(time.time()) - 60})
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_accepts_within_clock_skew(rsa_keys):
    cfg = _make_cfg(rsa_keys, clock_skew_seconds=30)
    token = _sign(rsa_keys, {"sub": "x", "exp": int(time.time()) - 5})
    claims = verify_jwt(token, cfg)
    assert claims["sub"] == "x"


@pytest.mark.no_host_override
def test_verify_jwt_rejects_wrong_issuer(rsa_keys):
    cfg = _make_cfg(rsa_keys, issuer="https://issuer.example")
    token = _sign(
        rsa_keys, {
            "sub": "x",
            "exp": int(time.time()) + 60,
            "iss": "https://attacker.example",
        })
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_rejects_wrong_audience(rsa_keys):
    cfg = _make_cfg(rsa_keys, audience="mirage-daemon")
    token = _sign(rsa_keys, {
        "sub": "x",
        "exp": int(time.time()) + 60,
        "aud": "something-else",
    })
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_rejects_unauthorized_party(rsa_keys):
    cfg = _make_cfg(rsa_keys, authorized_parties=("https://app.example", ))
    token = _sign(
        rsa_keys, {
            "sub": "x",
            "exp": int(time.time()) + 60,
            "azp": "https://attacker.example",
        })
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_accepts_matching_authorized_party(rsa_keys):
    cfg = _make_cfg(rsa_keys,
                    authorized_parties=("https://app.example",
                                        "https://other.example"))
    token = _sign(rsa_keys, {
        "sub": "x",
        "exp": int(time.time()) + 60,
        "azp": "https://other.example",
    })
    claims = verify_jwt(token, cfg)
    assert claims["sub"] == "x"


@pytest.mark.no_host_override
def test_verify_jwt_rejects_bad_typ_header(rsa_keys):
    cfg = _make_cfg(rsa_keys)
    token = _sign(rsa_keys, {
        "sub": "x",
        "exp": int(time.time()) + 60
    },
                  headers={"typ": "NotAJWT"})
    with pytest.raises(JWTVerificationError):
        verify_jwt(token, cfg)


@pytest.mark.no_host_override
def test_verify_jwt_accepts_missing_typ_header(rsa_keys):
    # Some issuers omit `typ` entirely. PyJWT does not require it,
    # and we should not force it when it's absent.
    cfg = _make_cfg(rsa_keys)
    token = _sign(rsa_keys, {"sub": "x", "exp": int(time.time()) + 60})
    claims = verify_jwt(token, cfg)
    assert claims["sub"] == "x"

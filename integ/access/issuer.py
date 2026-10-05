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
"""A mock OpenID issuer, shaped like Clerk's session tokens.

It signs RS256 tokens with ``iss``, ``sub``, ``azp``, ``sid``, ``iat``,
``nbf`` and a 60 second ``exp``, and no ``aud``, as Clerk's session
tokens carry. The server is given its public key, issuer and authorized
party, so the ``jwt`` deployment checks tokens the way a deployment that
reuses an app's sign-in would.
"""

import time
import uuid

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://clerk.mirage.test"
AUTHORIZED_PARTY = "https://app.mirage.test"
ACCOUNT = "user_alice"
LIFETIME = 60


def _key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _pem(key: rsa.RSAPrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


class Issuer:
    """Signs tokens for the ``jwt`` deployment, good ones and bad ones."""

    def __init__(self) -> None:
        self._key = _key()
        self._other = _key()

    @property
    def public_pem(self) -> str:
        """The public key the server verifies with, as PEM."""
        return (
            self._key.public_key()
            .public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode()
        )

    def claims(self, sub: str = ACCOUNT) -> dict[str, str | int]:
        """The claims of a fresh session token.

        Args:
            sub (str): the account the token speaks for.

        Returns:
            dict[str, str | int]: Clerk's session token claims.
        """
        now = int(time.time())
        return {
            "iss": ISSUER,
            "sub": sub,
            "azp": AUTHORIZED_PARTY,
            "sid": f"sess_{uuid.uuid4().hex[:12]}",
            "iat": now,
            "nbf": now - 1,
            "exp": now + LIFETIME,
        }

    def token(self, sub: str = ACCOUNT) -> str:
        """A valid token, minted now so it never expires mid-run.

        Args:
            sub (str): the account the token speaks for.

        Returns:
            str: the signed token.
        """
        return jwt.encode(self.claims(sub), _pem(self._key), algorithm="RS256")

    def bad(self) -> dict[str, str]:
        """Tokens the server must refuse, by what is wrong with them.

        Returns:
            dict[str, str]: name to token.
        """
        claims = self.claims()
        now = int(time.time())
        key = _pem(self._key)
        return {
            "jwt_expired": jwt.encode(
                {
                    **claims,
                    "iat": now - 600,
                    "nbf": now - 600,
                    "exp": now - 300,
                },
                key,
                algorithm="RS256",
            ),
            "jwt_wrong_issuer": jwt.encode(
                {**claims, "iss": "https://elsewhere.test"},
                key,
                algorithm="RS256",
            ),
            "jwt_wrong_party": jwt.encode(
                {**claims, "azp": "https://evil.test"}, key, algorithm="RS256"
            ),
            "jwt_wrong_key": jwt.encode(
                claims, _pem(self._other), algorithm="RS256"
            ),
            "jwt_alg_none": jwt.encode(claims, None, algorithm="none"),
            "jwt_hs256": jwt.encode(
                claims, "shared-secret-of-32-bytes-or-more!", algorithm="HS256"
            ),
            "opaque": "not-a-jwt",
        }

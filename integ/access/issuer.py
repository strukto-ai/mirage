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
"""A mock OpenID issuer, shaped like Clerk.

It signs two kinds of RS256 token, each with a ``kid``: session tokens
(``iss``, ``sub``, ``azp``, ``sid``, ``iat``, ``nbf``, a 60 second
``exp``, no ``aud``), as an app's sign-in carries them, and OAuth access
tokens (``iss``, ``sub``, ``aud`` naming the OAuth client, ``jti``, a
one day ``exp``), as a CLI that logged in through Clerk carries them. While it
serves, its URL is the issuer, and it answers Clerk's paths: the JWKS,
the authorization server metadata, ``/oauth/authorize`` (as a user who
is already signed in, so it sends the browser straight back with a
code) and ``/oauth/token`` (the code with PKCE, and refresh). The server
is given the JWKS URL, the issuer, the client as audience and login
client, and the app as authorized party, so the ``jwt`` deployment
checks tokens, and ``mirage login`` signs in, the way a Clerk deployment
would.
"""

import base64
import hashlib
import json
import secrets
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

AUTHORIZED_PARTY = "https://app.mirage.test"
CLIENT_ID = "client_mirage_cli"
ACCOUNT = "user_alice"
KEY_ID = "ins_mirage_test"
LIFETIME = 60
OAUTH_LIFETIME = 24 * 60 * 60


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
        self.url = ""
        self.jwks_url = ""
        self._codes: dict[str, dict[str, str]] = {}
        self._refresh: set[str] = set()

    def _sign(
        self,
        claims: dict[str, str | int],
        key: rsa.RSAPrivateKey | None = None,
    ) -> str:
        return jwt.encode(
            claims,
            _pem(key if key is not None else self._key),
            algorithm="RS256",
            headers={"kid": KEY_ID},
        )

    def _authorize(self, query: dict[str, str]) -> str:
        """Where the browser goes next: back to the CLI with a code, as
        a signed-in user's browser does."""
        redirect = query.get("redirect_uri", "")
        answer = {"state": query.get("state", "")}
        if (
            query.get("client_id") != CLIENT_ID
            or query.get("response_type") != "code"
            or query.get("code_challenge_method") != "S256"
            or not redirect.startswith("http://127.0.0.1:")
        ):
            answer["error"] = "invalid_request"
        else:
            code = secrets.token_urlsafe(16)
            self._codes[code] = query
            answer["code"] = code
        return f"{redirect}?{urlencode(answer)}"

    def _token(self, form: dict[str, str]) -> tuple[int, dict[str, Any]]:
        """Swap a code (with its PKCE verifier) or a refresh token for
        an OAuth access token."""
        grant = form.get("grant_type")
        if grant == "refresh_token":
            if form.get("refresh_token") not in self._refresh:
                return 400, {"error": "invalid_grant"}
            return 200, {
                "access_token": self.oauth_token(),
                "token_type": "Bearer",
                "expires_in": OAUTH_LIFETIME,
            }
        asked = self._codes.pop(form.get("code", ""), None)
        digest = hashlib.sha256(form.get("code_verifier", "").encode())
        proof = base64.urlsafe_b64encode(digest.digest()).rstrip(b"=")
        if (
            grant != "authorization_code"
            or asked is None
            or form.get("client_id") != asked["client_id"]
            or form.get("redirect_uri") != asked["redirect_uri"]
            or proof.decode() != asked["code_challenge"]
        ):
            return 400, {"error": "invalid_grant"}
        refresh = secrets.token_urlsafe(24)
        self._refresh.add(refresh)
        return 200, {
            "access_token": self.oauth_token(),
            "token_type": "Bearer",
            "expires_in": OAUTH_LIFETIME,
            "refresh_token": refresh,
        }

    @contextmanager
    def serving(self) -> Iterator[str]:
        """Serve Clerk's paths while the block runs.

        Yields:
            str: the JWKS URL, also kept as ``jwks_url``; the issuer is
                ``url``.
        """
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(
            self._key.public_key(), as_dict=True
        )
        keys = {"keys": [{**jwk, "kid": KEY_ID, "use": "sig", "alg": "RS256"}]}
        issuer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(
                self, status: int, body: dict[str, Any], **headers: str
            ) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                parts = urlsplit(self.path)
                query = {k: v[0] for k, v in parse_qs(parts.query).items()}
                if parts.path == "/.well-known/jwks.json":
                    self.reply(200, keys)
                elif parts.path == "/.well-known/oauth-authorization-server":
                    self.reply(
                        200,
                        {
                            "issuer": issuer.url,
                            "authorization_endpoint": (
                                f"{issuer.url}/oauth/authorize"
                            ),
                            "token_endpoint": f"{issuer.url}/oauth/token",
                            "jwks_uri": issuer.jwks_url,
                            "response_types_supported": ["code"],
                            "grant_types_supported": [
                                "authorization_code",
                                "refresh_token",
                            ],
                            "code_challenge_methods_supported": ["S256"],
                        },
                    )
                elif parts.path == "/oauth/authorize":
                    self.reply(302, {}, Location=issuer._authorize(query))
                else:
                    self.reply(404, {})

            def do_POST(self) -> None:
                size = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(size).decode()
                form = {k: v[0] for k, v in parse_qs(raw).items()}
                if urlsplit(self.path).path != "/oauth/token":
                    self.reply(404, {})
                    return
                status, body = issuer._token(form)
                self.reply(status, body)

            def log_message(self, *args: Any) -> None:
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{server.server_address[1]}"
        self.jwks_url = f"{self.url}/.well-known/jwks.json"
        try:
            yield self.jwks_url
        finally:
            server.shutdown()

    def claims(self, sub: str = ACCOUNT) -> dict[str, str | int]:
        """The claims of a fresh session token.

        Args:
            sub (str): the account the token speaks for.

        Returns:
            dict[str, str | int]: Clerk's session token claims.
        """
        now = int(time.time())
        return {
            "iss": self.url,
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
        return self._sign(self.claims(sub))

    def oauth_claims(
        self, sub: str = ACCOUNT, aud: str = CLIENT_ID
    ) -> dict[str, str | int]:
        """The claims of a fresh OAuth access token.

        Args:
            sub (str): the account the token speaks for.
            aud (str): the OAuth client it was issued to.

        Returns:
            dict[str, str | int]: Clerk's OAuth access token claims.
        """
        now = int(time.time())
        return {
            "iss": self.url,
            "sub": sub,
            "aud": aud,
            "jti": f"oat_{uuid.uuid4().hex}",
            "iat": now,
            "nbf": now - 1,
            "exp": now + OAUTH_LIFETIME,
        }

    def oauth_token(self, sub: str = ACCOUNT) -> str:
        """A valid OAuth access token, as a CLI login holds one.

        Args:
            sub (str): the account the token speaks for.

        Returns:
            str: the signed token.
        """
        return self._sign(self.oauth_claims(sub))

    def bad(self) -> dict[str, str]:
        """Tokens the server must refuse, by what is wrong with them.

        Returns:
            dict[str, str]: name to token.
        """
        claims = self.claims()
        now = int(time.time())
        no_party = {k: v for k, v in claims.items() if k != "azp"}
        return {
            "jwt_expired": self._sign(
                {
                    **claims,
                    "iat": now - 600,
                    "nbf": now - 600,
                    "exp": now - 300,
                }
            ),
            "jwt_wrong_issuer": self._sign(
                {**claims, "iss": "https://elsewhere.test"}
            ),
            "jwt_wrong_party": self._sign(
                {**claims, "azp": "https://evil.test"}
            ),
            "jwt_no_party": self._sign(no_party),
            "jwt_wrong_key": self._sign(claims, self._other),
            "oauth_wrong_audience": self._sign(
                self.oauth_claims(aud="client_someone_else")
            ),
            "jwt_alg_none": jwt.encode(claims, None, algorithm="none"),
            "jwt_hs256": jwt.encode(
                claims, "shared-secret-of-32-bytes-or-more!", algorithm="HS256"
            ),
            "opaque": "not-a-jwt",
        }

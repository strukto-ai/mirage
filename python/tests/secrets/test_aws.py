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

from mirage.secrets import aws
from mirage.secrets.aws import fetch_aws_sm, fields_from_secret_string
from mirage.secrets.config import AWSSMConfig
from mirage.secrets.errors import SecretsError


class StubClientContext:

    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, exc_type, exc, tb):
        return False


class StubClient:

    def __init__(self, response):
        self.response = response
        self.secret_ids = []

    async def get_secret_value(self, SecretId):
        self.secret_ids.append(SecretId)
        return self.response


class StubSession:

    def __init__(self, client):
        self._client = client
        self.client_kwargs = None

    def client(self, **kwargs):
        self.client_kwargs = kwargs
        return StubClientContext(self._client)


@pytest.mark.parametrize(
    "text,fields",
    [
        ('{"user": "u", "password": "p"}', {
            "user": "u",
            "password": "p"
        }),
        ("plain-token", {
            "value": "plain-token"
        }),
        ("[1, 2]", {
            "value": "[1, 2]"
        }),
        ('{"port": 5432}', {
            "value": '{"port": 5432}'
        }),
        ("123", {
            "value": "123"
        }),
    ],
)
def test_fields_from_secret_string(text, fields):
    assert fields_from_secret_string(text) == fields


@pytest.mark.asyncio
async def test_fetch_aws_sm_reads_the_secret_through_the_client(monkeypatch):
    client = StubClient({"SecretString": '{"api": "tok"}'})
    session = StubSession(client)

    def stub_session(config):
        return session

    monkeypatch.setattr(aws, "aws_session", stub_session)
    config = AWSSMConfig(region="us-east-1",
                         aws_access_key_id="AKIA",
                         aws_secret_access_key="shh",
                         aws_session_token="tok")
    secret = await fetch_aws_sm(config, "prod/tokens")
    assert secret.fields == {"api": "tok"}
    assert secret.expires_at is None
    assert client.secret_ids == ["prod/tokens"]
    assert session.client_kwargs == {
        "service_name": "secretsmanager",
        "region_name": "us-east-1",
        "aws_access_key_id": "AKIA",
        "aws_secret_access_key": "shh",
        "aws_session_token": "tok",
    }


@pytest.mark.asyncio
async def test_fetch_aws_sm_omits_unset_auth_kwargs(monkeypatch):
    client = StubClient({"SecretString": "plain"})
    session = StubSession(client)
    monkeypatch.setattr(aws, "aws_session", lambda config: session)
    secret = await fetch_aws_sm(AWSSMConfig(), "name")
    assert secret.fields == {"value": "plain"}
    assert session.client_kwargs == {"service_name": "secretsmanager"}


@pytest.mark.asyncio
async def test_fetch_aws_sm_refuses_an_empty_ref():
    with pytest.raises(SecretsError, match="SecretId"):
        await fetch_aws_sm(AWSSMConfig(), "")


@pytest.mark.asyncio
async def test_fetch_aws_sm_refuses_a_binary_secret(monkeypatch):
    client = StubClient({"SecretBinary": b"\x00\x01"})
    session = StubSession(client)
    monkeypatch.setattr(aws, "aws_session", lambda config: session)
    with pytest.raises(SecretsError, match="SecretBinary"):
        await fetch_aws_sm(AWSSMConfig(), "bin-secret")

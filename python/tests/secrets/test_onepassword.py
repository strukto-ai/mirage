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

from types import SimpleNamespace

import pytest

from mirage.secrets import onepassword
from mirage.secrets.config import OnePasswordConfig
from mirage.secrets.errors import SecretsError
from mirage.secrets.onepassword import (TOKEN_VAR, fetch_onepassword,
                                        fields_from_item, onepassword_client,
                                        parse_op_ref)
from mirage.version import __version__


def overview(ident, title):
    return SimpleNamespace(id=ident, title=title)


def field(title, value):
    return SimpleNamespace(title=title, value=value)


def item(fields, notes=""):
    return SimpleNamespace(fields=fields, notes=notes)


class StubSecrets:

    def __init__(self, values):
        self.values = values
        self.refs = []

    async def resolve(self, ref):
        self.refs.append(ref)
        return self.values[ref]


class StubVaults:

    def __init__(self, vaults):
        self.vaults = vaults
        self.calls = 0

    async def list(self, params=None):
        self.calls += 1
        return self.vaults


class StubItems:

    def __init__(self, overviews, items):
        self.overviews = overviews
        self.items = items
        self.gets = []

    async def list(self, vault_id, *filters):
        return self.overviews.get(vault_id, [])

    async def get(self, vault_id, item_id):
        self.gets.append((vault_id, item_id))
        return self.items[item_id]


class StubClient:

    def __init__(self, *, vaults=(), overviews=None, items=None, values=None):
        self.vaults = StubVaults(list(vaults))
        self.items = StubItems(overviews or {}, items or {})
        self.secrets = StubSecrets(values or {})


class StubAuth:

    calls = []

    @classmethod
    async def authenticate(cls, auth, integration_name, integration_version):
        cls.calls.append((auth, integration_name, integration_version))
        return StubClient()


@pytest.mark.parametrize(
    "ref,parsed",
    [
        ("op://mirage/SLACK_BOT_TOKEN", ("mirage", "SLACK_BOT_TOKEN", "")),
        ("op://mirage/tok/credential", ("mirage", "tok", "credential")),
        ("op://mirage/aws/keys/access_key_id",
         ("mirage", "aws", "access_key_id")),
    ],
)
def test_parse_op_ref(ref, parsed):
    assert parse_op_ref(ref) == parsed


@pytest.mark.parametrize(
    "ref,message",
    [
        ("", "needs a ref"),
        ("mirage/tok", "op:// url"),
        ("op://mirage", "a vault and an item"),
        ("op://mirage/", "a vault and an item"),
        ("op:///tok", "a vault and an item"),
    ],
)
def test_parse_op_ref_refuses(ref, message):
    with pytest.raises(SecretsError, match=message):
        parse_op_ref(ref)


def test_fields_from_item_keys_by_label():
    fields = fields_from_item(
        item([field("username", "u"),
              field("credential", "shh")]))
    assert fields == {"username": "u", "credential": "shh"}


def test_fields_from_item_folds_in_the_note():
    fields = fields_from_item(item([field("credential", "shh")], notes="hi"))
    assert fields == {"credential": "shh", "notesPlain": "hi"}


def test_fields_from_item_skips_an_unlabelled_field():
    assert fields_from_item(item([field("", "x"),
                                  field("credential", "shh")])) == {
                                      "credential": "shh"
                                  }


def test_fields_from_item_keeps_a_dunder_label():
    """Free in python; the TypeScript twin has to build the map with
    Object.fromEntries, since keyed assignment runs the prototype
    setter for `__proto__` and leaves no own property."""
    assert fields_from_item(item([field("__proto__", "shh")])) == {
        "__proto__": "shh"
    }


def test_fields_from_item_keeps_a_notes_field_over_the_note():
    fields = fields_from_item(
        item([field("notesPlain", "from-field")], notes="from-note"))
    assert fields == {"notesPlain": "from-field"}


@pytest.mark.asyncio
async def test_fetch_reads_every_field_of_an_item_ref(monkeypatch):
    client = StubClient(
        vaults=[overview("v1", "mirage")],
        overviews={"v1": [overview("i1", "aws")]},
        items={
            "i1":
            item([
                field("access_key_id", "AKIA"),
                field("secret_access_key", "shh"),
            ])
        },
    )

    async def stub_client(config):
        return client

    monkeypatch.setattr(onepassword, "onepassword_client", stub_client)
    secret = await fetch_onepassword(OnePasswordConfig(), "op://mirage/aws")
    assert secret.fields == {
        "access_key_id": "AKIA",
        "secret_access_key": "shh"
    }
    assert secret.expires_at is None
    assert client.items.gets == [("v1", "i1")]
    assert client.secrets.refs == []


@pytest.mark.asyncio
async def test_fetch_matches_a_vault_and_item_by_id(monkeypatch):
    client = StubClient(
        vaults=[overview("v1", "mirage")],
        overviews={"v1": [overview("i1", "aws")]},
        items={"i1": item([field("credential", "shh")])},
    )

    async def stub_client(config):
        return client

    monkeypatch.setattr(onepassword, "onepassword_client", stub_client)
    secret = await fetch_onepassword(OnePasswordConfig(), "op://v1/i1")
    assert secret.fields == {"credential": "shh"}


@pytest.mark.asyncio
async def test_fetch_resolves_a_field_ref_without_listing(monkeypatch):
    ref = "op://mirage/tok/credential"
    client = StubClient(values={ref: "shh"})

    async def stub_client(config):
        return client

    monkeypatch.setattr(onepassword, "onepassword_client", stub_client)
    secret = await fetch_onepassword(OnePasswordConfig(), ref)
    assert secret.fields == {"credential": "shh"}
    assert client.secrets.refs == [ref]
    assert client.vaults.calls == 0
    assert client.items.gets == []


@pytest.mark.asyncio
async def test_fetch_refuses_an_unknown_vault(monkeypatch):
    client = StubClient(vaults=[overview("v1", "other")])

    async def stub_client(config):
        return client

    monkeypatch.setattr(onepassword, "onepassword_client", stub_client)
    with pytest.raises(SecretsError, match="vault 'mirage' not found"):
        await fetch_onepassword(OnePasswordConfig(), "op://mirage/aws")


@pytest.mark.asyncio
async def test_fetch_refuses_an_unknown_item(monkeypatch):
    client = StubClient(vaults=[overview("v1", "mirage")],
                        overviews={"v1": [overview("i1", "other")]})

    async def stub_client(config):
        return client

    monkeypatch.setattr(onepassword, "onepassword_client", stub_client)
    with pytest.raises(SecretsError, match="item 'aws' not found"):
        await fetch_onepassword(OnePasswordConfig(), "op://mirage/aws")


@pytest.mark.asyncio
async def test_client_uses_the_configured_token(monkeypatch):
    StubAuth.calls = []
    monkeypatch.setattr(onepassword, "Client", StubAuth)
    monkeypatch.setenv(TOKEN_VAR, "ops_from_env")
    await onepassword_client(OnePasswordConfig(token="ops_declared"))
    assert StubAuth.calls == [("ops_declared", "mirage", __version__)]


@pytest.mark.asyncio
async def test_client_falls_back_to_the_env_token(monkeypatch):
    StubAuth.calls = []
    monkeypatch.setattr(onepassword, "Client", StubAuth)
    monkeypatch.setenv(TOKEN_VAR, "ops_from_env")
    await onepassword_client(OnePasswordConfig())
    assert StubAuth.calls == [("ops_from_env", "mirage", __version__)]


@pytest.mark.asyncio
async def test_client_refuses_a_missing_token(monkeypatch):
    monkeypatch.setattr(onepassword, "Client", StubAuth)
    monkeypatch.delenv(TOKEN_VAR, raising=False)
    with pytest.raises(SecretsError, match=TOKEN_VAR):
        await onepassword_client(OnePasswordConfig())

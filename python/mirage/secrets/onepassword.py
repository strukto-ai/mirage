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
from typing import cast

from onepassword.client import Client
from onepassword.types import Item

from mirage.secrets.config import OnePasswordConfig
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret
from mirage.version import __version__

OP_SCHEME = "op://"
TOKEN_VAR = "OP_SERVICE_ACCOUNT_TOKEN"
INTEGRATION_NAME = "mirage"

# What `op://vault/item/notesPlain` addresses: an item's note is not an
# `ItemField`, so it is folded in under the name the ref grammar gives
# it rather than being invisible to a `key`.
NOTES_KEY = "notesPlain"


def parse_op_ref(ref: str) -> tuple[str, str, str]:
    """Split a 1Password secret reference into vault, item and field.

    Both of 1Password's own ref shapes are accepted, and they mean
    different fetches: an item reference reads every field, so N
    variables out of one item cost one call, while a field reference is
    resolved as itself, which is what the app's "Copy Secret Reference"
    button hands you.

    Args:
        ref (str): `op://<vault>/<item>`, or a field reference,
            `op://<vault>/<item>[/<section>]/<field>`.

    Returns:
        tuple[str, str, str]: the vault, the item, and the field label
            -- empty for an item reference.

    Raises:
        SecretsError: an empty ref, a ref that is not an `op://` url,
            or one naming less than a vault and an item.
    """
    if not ref:
        raise SecretsError("the '1password' source needs a ref: "
                           "op://<vault>/<item>")
    if not ref.startswith(OP_SCHEME):
        raise SecretsError(f"a '1password' ref is an op:// url, got {ref!r}")
    parts = ref[len(OP_SCHEME):].split("/")
    if len(parts) < 2 or not all(parts):
        raise SecretsError(
            f"a '1password' ref names a vault and an item, got {ref!r}")
    return parts[0], parts[1], parts[-1] if len(parts) > 2 else ""


async def onepassword_client(config: OnePasswordConfig) -> Client:
    """Authenticate a 1Password SDK client.

    Module-level for the reason ``aws_session`` is: a test replaces it
    with a stub. Built per fetch rather than cached, because a fetched
    value lands on a session var and never refetches, so a cache would
    keep an authenticated handle alive long past the line that needed
    one.

    Args:
        config (OnePasswordConfig): the source's token, if declared.

    Raises:
        SecretsError: neither the config nor the process env carries a
            service account token.
    """
    token = (config.token.get_secret_value()
             if config.token is not None else os.environ.get(TOKEN_VAR, ""))
    if not token:
        raise SecretsError(
            "the '1password' source needs a service account token: set "
            f"{TOKEN_VAR}, or give the source a 'token'")
    return await Client.authenticate(auth=token,
                                     integration_name=INTEGRATION_NAME,
                                     integration_version=__version__)


async def find_vault_id(client: Client, name: str) -> str:
    """Resolve a vault's id from the name a ref spells.

    A ref names a vault by title, which the item API cannot take, so
    this is the extra call an item reference costs. An id matches too,
    so a deployment that pins ids never pays for the title lookup being
    wrong after a rename.

    Args:
        client (Client): an authenticated client.
        name (str): the ref's vault segment, a title or an id.

    Raises:
        SecretsError: no vault of that title or id is readable.
    """
    for vault in await client.vaults.list():
        if name in (vault.id, vault.title):
            return cast(str, vault.id)
    raise SecretsError(f"1password vault {name!r} not found")


async def find_item_id(client: Client, vault_id: str, name: str) -> str:
    """Resolve an item's id within one vault, by title or by id.

    Args:
        client (Client): an authenticated client.
        vault_id (str): the vault to look in.
        name (str): the ref's item segment, a title or an id.

    Raises:
        SecretsError: no item of that title or id is in the vault.
    """
    for item in await client.items.list(vault_id):
        if name in (item.id, item.title):
            return cast(str, item.id)
    raise SecretsError(f"1password item {name!r} not found")


def fields_from_item(item: Item) -> dict[str, str]:
    """Shape one item into secret fields, keyed by field label.

    Labels are what a ref and a managed entry's ``key`` both address,
    and 1Password fixes the built-in ones per category (an API
    Credential item's secret is ``credential``), so they are the keys
    here. Two fields sharing a label in different sections is the one
    ambiguity, and the later one wins -- the SDK refuses such a ref
    outright, so neither shape promises more than the other.

    Args:
        item (Item): the item as the SDK returned it.

    Returns:
        dict[str, str]: the item's fields, plus its note when it has
            one.
    """
    fields = {field.title: field.value for field in item.fields if field.title}
    if item.notes:
        fields.setdefault(NOTES_KEY, item.notes)
    return fields


async def fetch_onepassword(config: OnePasswordConfig,
                            ref: str) -> ResolvedSecret:
    """Fetch one secret from 1Password.

    A field reference is one ``resolve`` call and returns that field
    alone, keyed by its label; an item reference is a vault lookup, an
    item lookup and a get, and returns every field, which is what lets
    one AWS item fill four variables on one await.

    Args:
        config (OnePasswordConfig): the source's token, if declared.
        ref (str): an `op://` item or field reference.

    Returns:
        ResolvedSecret: the secret's fields. 1Password does not expire
            an item, so ``expires_at`` stays None.

    Raises:
        SecretsError: a malformed ref, a missing token, or a vault or
            item the service account cannot read.
    """
    vault, item, field = parse_op_ref(ref)
    client = await onepassword_client(config)
    if field:
        return ResolvedSecret(
            fields={field: await client.secrets.resolve(ref)})
    vault_id = await find_vault_id(client, vault)
    item_id = await find_item_id(client, vault_id, item)
    return ResolvedSecret(
        fields=fields_from_item(await client.items.get(vault_id, item_id)))

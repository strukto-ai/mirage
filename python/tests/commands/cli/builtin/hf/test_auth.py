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

from unittest.mock import patch

import pytest

from mirage.commands.cli.builtin.hf.auth import list_cmd, whoami_cmd
from mirage.commands.errors import UsageError
from mirage.core.hf_hub.config import HfConfig
from mirage.io.types import materialize
from tests.commands.cli.builtin.hf.conftest import ANON, inv


async def _text(result) -> str:
    source, _ = result
    return (await materialize(source)).decode()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_whoami_labels_the_orgs_the_way_upstream_does(mock_whoami):
    """An unlabelled org is indistinguishable from the account itself.

    Upstream prints the label and the joined names as two print arguments,
    which puts a second space after the colon. Measured: printed bare, an
    agent asked to create a repo under its own account read the org off the
    second line and created it there instead.
    """
    mock_whoami.return_value = {
        "name": "zoe",
        "orgs": [{
            "name": "acme"
        }, {
            "name": "widgets"
        }],
    }
    assert await _text(await whoami_cmd(inv())) == "zoe\norgs:  acme,widgets\n"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_whoami_says_nothing_of_orgs_when_there_are_none(mock_whoami):
    mock_whoami.return_value = {"name": "zoe", "orgs": []}
    assert await _text(await whoami_cmd(inv())) == "zoe\n"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_whoami_names_a_private_endpoint(mock_whoami):
    """Upstream reports any origin that is not huggingface.co, and for a
    mirage install that is every origin: the endpoint is the deployment's."""
    mock_whoami.return_value = {"name": "zoe"}
    config = HfConfig(token="hf_test", endpoint="http://127.0.0.1:5199")
    text = await _text(await whoami_cmd(inv(config=config)))
    assert text == ("zoe\nAuthenticated through private endpoint: "
                    "http://127.0.0.1:5199\n")


@pytest.mark.asyncio
async def test_whoami_refuses_without_a_token():
    """The Hub answers 401 'Invalid username or password.' for an
    anonymous call, which reads as a wrong credential, not a missing
    one."""
    with pytest.raises(UsageError):
        await whoami_cmd(inv(config=ANON))


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_auth_list_reports_the_one_install_credential(mock_whoami):
    """A workspace has no token store; an install carries exactly one
    credential, so the list is that one and never more."""
    mock_whoami.return_value = {"name": "zoe"}
    text = await _text(await list_cmd(inv()))
    assert text.splitlines()[0].split() == ["NAME", "TOKEN"]
    assert text.splitlines()[1].startswith("zoe")
    assert "hf_test" not in text


@pytest.mark.asyncio
async def test_auth_list_is_just_a_header_without_a_token():
    text = await _text(await list_cmd(inv(config=ANON)))
    assert len(text.splitlines()) == 1

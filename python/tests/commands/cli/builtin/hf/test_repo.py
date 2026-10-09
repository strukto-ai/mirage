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

from mirage.commands.cli.builtin.hf.repo import (
    create_cmd,
    tag_create_cmd,
    tag_delete_cmd,
    tag_list_cmd,
)
from mirage.commands.errors import UsageError
from mirage.io.types import materialize
from tests.commands.cli.builtin.hf.conftest import ANON, inv


async def _text(result) -> str:
    source, _ = result
    return (await materialize(source)).decode()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_repo")
async def test_create_prints_the_url_the_hub_answered(mock_create):
    mock_create.return_value = {"url": "https://hf.co/acme/widget"}
    text = await _text(await create_cmd(inv(texts=("acme/widget",))))
    assert text == "https://hf.co/acme/widget\n"


@pytest.mark.asyncio
async def test_create_refuses_a_space_without_an_sdk():
    """Upstream spells the flag --space_sdk, with an underscore, alone
    among hf's options; the refusal has to name it the way the line
    would."""
    with pytest.raises(UsageError, match="--space_sdk"):
        await create_cmd(
            inv(texts=("acme/demo",), flags={"repo_type": "space"})
        )


@pytest.mark.asyncio
async def test_create_refuses_without_a_token():
    with pytest.raises(UsageError):
        await create_cmd(inv(texts=("acme/widget",), config=ANON))


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_tag")
async def test_tag_create_tags_the_named_revision(mock_tag):
    text = await _text(
        await tag_create_cmd(
            inv(
                texts=("acme/widget", "v1"),
                flags={"revision": "dev", "message": "cut"},
            )
        )
    )
    assert text == "Tag v1 created on acme/widget\n"
    assert mock_tag.await_args.kwargs["revision"] == "dev"
    assert mock_tag.await_args.kwargs["message"] == "cut"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_tag")
async def test_tag_create_defaults_to_the_default_revision(mock_tag):
    await tag_create_cmd(inv(texts=("acme/widget", "v1")))
    assert mock_tag.await_args.kwargs["revision"] == "main"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.list_tags")
async def test_tag_list_prints_one_tag_per_line(mock_list):
    mock_list.return_value = ["v1", "v2"]
    assert (
        await _text(await tag_list_cmd(inv(texts=("acme/widget",))))
        == "v1\nv2\n"
    )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.delete_tag_api")
async def test_tag_delete_needs_the_yes_flag(mock_delete):
    """Upstream asks on stdin and takes -y to skip the question. A
    workspace verb has no terminal to ask on, so deleting because
    nobody could answer is the wrong default."""
    with pytest.raises(UsageError, match="-y"):
        await tag_delete_cmd(inv(texts=("acme/widget", "v1")))
    mock_delete.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.delete_tag_api")
async def test_tag_delete_removes_the_tag_with_yes(mock_delete):
    text = await _text(
        await tag_delete_cmd(
            inv(texts=("acme/widget", "v1"), flags={"yes": True})
        )
    )
    assert text == "Tag v1 deleted on acme/widget\n"
    assert mock_delete.await_args.args[1:3] == ("acme/widget", "v1")


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.delete_tag_api")
async def test_tag_delete_takes_yes_on_stdin(mock_delete):
    """Upstream reads the answer with input(); a piped y is the same
    answer arriving the only way a workspace can send it."""
    await tag_delete_cmd(inv(texts=("acme/widget", "v1"), stdin=b"y\n"))
    assert mock_delete.await_count == 1


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.delete_tag_api")
async def test_tag_delete_declines_anything_but_yes(mock_delete):
    with pytest.raises(UsageError):
        await tag_delete_cmd(inv(texts=("acme/widget", "v1"), stdin=b"n\n"))
    mock_delete.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_repo")
async def test_create_passes_exist_ok_through(mock_create):
    mock_create.return_value = {}
    await create_cmd(inv(texts=("acme/widget",), flags={"exist_ok": True}))
    assert mock_create.await_args.kwargs["exist_ok"] is True


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_repo")
async def test_create_falls_back_to_the_repo_url_it_can_derive(mock_create):
    """The kind decides the path segment: a model sits at the origin
    root, a dataset and a space under a plural one."""
    mock_create.return_value = {}
    text = await _text(
        await create_cmd(
            inv(texts=("acme/rows",), flags={"repo_type": "dataset"})
        )
    )
    assert text == "https://huggingface.co/datasets/acme/rows\n"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_tag")
async def test_tag_create_refuses_a_missing_tag_before_calling_out(mock_tag):
    """Direct handler calls reject missing arguments before contacting the Hub."""
    with pytest.raises(
        UsageError, match="the following arguments are required: tag"
    ):
        await tag_create_cmd(inv(texts=("acme/widget",)))
    mock_tag.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.delete_tag_api")
async def test_tag_delete_refuses_a_missing_tag(mock_delete):
    with pytest.raises(UsageError, match="required: tag"):
        await tag_delete_cmd(inv(texts=("acme/widget",), flags={"yes": True}))
    mock_delete.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.list_tags")
async def test_tag_list_refuses_a_missing_repo(mock_list):
    with pytest.raises(UsageError, match="required: repo_id"):
        await tag_list_cmd(inv())
    mock_list.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.repo.create_tag")
async def test_tag_create_names_every_empty_slot(mock_tag):
    with pytest.raises(UsageError, match="required: repo_id, tag"):
        await tag_create_cmd(inv())
    mock_tag.assert_not_awaited()

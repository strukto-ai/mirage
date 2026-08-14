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

import json
from email.parser import BytesParser
from email.policy import default as default_policy

import pytest

from mirage.commands.cli.builtin.himalaya import compose
from mirage.commands.cli.builtin.himalaya import util as util_module
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import IOResult, materialize
from mirage.types import PathSpec

CONFIG = EmailConfig(imap_host="h",
                     smtp_host="h",
                     username="me@example.com",
                     password="p")

FILES = {"/scratch/note.txt": b"the note body\n"}


async def fake_dispatch(op, path, *args, **kwargs):
    if op != "read":
        raise AssertionError(f"unexpected op {op}")
    if path.virtual not in FILES:
        raise FileNotFoundError(path.virtual)
    return FILES[path.virtual], IOResult()


def doors_with_files() -> CLIDoors:
    return CLIDoors(dispatch=fake_dispatch)


@pytest.fixture
def sent(monkeypatch):
    seen: dict = {}

    async def fake_deliver(config, raw, save=None):
        seen["raw"] = raw
        seen["save"] = save
        return BytesParser(policy=default_policy).parsebytes(raw), ""

    async def fake_save(config, raw, folder=None):
        if seen.get("refuse"):
            raise ValueError(f"{folder}: [TRYCREATE] No such mailbox")
        seen["saved"] = (raw, folder)
        return folder or "Sent"

    monkeypatch.setattr(util_module, "deliver", fake_deliver)
    monkeypatch.setattr(util_module, "save_sent_copy", fake_save)
    return seen


@pytest.mark.asyncio
async def test_compose_writes_mime_to_stdout_without_send(sent):
    out, io = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@b.com",
                          "subject": "Hi",
                          "body": "yo"
                      }))
    assert io.exit_code == 0
    assert "raw" not in sent
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["From"] == "me@example.com"
    assert message["To"] == "a@b.com"
    assert message["Subject"] == "Hi"
    assert message.get_content().strip() == "yo"


@pytest.mark.asyncio
async def test_send_flag_pushes_through_smtp_and_reports_json(sent):
    out, io = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@b.com",
                          "subject": "Hi",
                          "body": "yo",
                          "send": True
                      }))
    assert io.exit_code == 0
    assert b"Subject: Hi" in sent["raw"]
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "a@b.com",
        "subject": "Hi",
    }


@pytest.mark.asyncio
async def test_recipients_accept_repeats_and_comma_lists(sent):
    out, _ = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": ["a@x, b@x", "c@x"],
                          "cc": "d@x",
                          "subject": "Hi",
                          "body": "yo"
                      }))
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["To"] == "a@x, b@x, c@x"
    assert message["Cc"] == "d@x"


@pytest.mark.asyncio
async def test_body_falls_back_to_stdin(sent):
    out, _ = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@x",
                          "subject": "Hi"
                      },
                      stdin=b"piped body"))
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message.get_content().strip() == "piped body"


@pytest.mark.asyncio
async def test_from_flag_overrides_the_account_username(sent):
    out, _ = await compose(
        CLIInvocation(CONFIG, flags={
            "to": "a@x",
            "body": "yo",
            "from": "x@y"
        }))
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["From"] == "x@y"


@pytest.mark.asyncio
async def test_compose_without_a_recipient_is_refused(sent):
    with pytest.raises(ValueError, match="no recipient"):
        await compose(
            CLIInvocation(CONFIG, flags={
                "subject": "Hi",
                "body": "yo"
            }))


@pytest.mark.asyncio
async def test_attach_reads_through_the_dispatcher_into_multipart(sent):
    out, io = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@b.com",
                          "subject": "files",
                          "body": "see attached",
                          "attach":
                          [PathSpec.from_str_path("/scratch/note.txt")],
                      },
                      doors=doors_with_files()))
    assert io.exit_code == 0
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message.get_content_type() == "multipart/mixed"
    parts = list(message.iter_parts())
    # The stdout bytes ride the SMTP policy, so the body keeps CRLF.
    assert parts[0].get_content() == "see attached\r\n"
    assert parts[1].get_filename() == "note.txt"
    assert parts[1].get_content_type() == "text/plain"
    assert parts[1].get_content() == "the note body\n"


@pytest.mark.asyncio
async def test_attach_of_a_missing_file_names_the_path(sent):
    with pytest.raises(ValueError,
                       match=r"read attachment /scratch/gone.txt: "
                       r"No such file or directory"):
        await compose(
            CLIInvocation(CONFIG,
                          flags={
                              "to":
                              "a@b.com",
                              "body":
                              "yo",
                              "attach":
                              [PathSpec.from_str_path("/scratch/gone.txt")],
                          },
                          doors=doors_with_files()))


@pytest.mark.asyncio
async def test_attach_outside_a_workspace_is_refused(sent):
    with pytest.raises(ValueError, match="needs a workspace"):
        await compose(
            CLIInvocation(CONFIG,
                          flags={
                              "to":
                              "a@b.com",
                              "body":
                              "yo",
                              "attach":
                              [PathSpec.from_str_path("/scratch/note.txt")],
                          }))


@pytest.mark.asyncio
async def test_save_rides_along_to_the_delivery(sent):
    await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@b.com",
                          "body": "yo",
                          "send": True,
                          "save": "Drafts",
                      }))
    assert sent["save"] == "Drafts"


@pytest.mark.asyncio
async def test_save_without_send_files_the_message_and_sends_nothing(sent):
    out, io = await compose(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "a@b.com",
                          "subject": "Draft it",
                          "body": "yo",
                          "save": "Drafts",
                      }))
    assert io.exit_code == 0
    assert "raw" not in sent
    assert sent["saved"][1] == "Drafts"
    assert json.loads(await materialize(out)) == {
        "status": "saved",
        "mailbox": "Drafts",
        "to": "a@b.com",
        "subject": "Draft it",
    }


@pytest.mark.asyncio
async def test_a_refused_save_without_send_fails_loudly(sent):
    # Nothing was sent, so there is no delivered message a retry could
    # duplicate: this one is an error, not a warning.
    sent["refuse"] = True
    with pytest.raises(ValueError, match="Drafts: .*TRYCREATE"):
        await compose(
            CLIInvocation(CONFIG,
                          flags={
                              "to": "a@b.com",
                              "body": "yo",
                              "save": "Drafts",
                          }))

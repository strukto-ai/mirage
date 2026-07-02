import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

sys.modules.setdefault(
    "aioimaplib",
    SimpleNamespace(IMAP4=object, IMAP4_SSL=object),
)
sys.modules.setdefault(
    "aiosmtplib",
    SimpleNamespace(SMTP=object, send=AsyncMock()),
)

_grep_server_side = importlib.import_module(
    "mirage.commands.builtin.email.grep")._grep_server_side


@pytest.mark.asyncio
async def test_grep_server_side_count_uses_real_count():
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    pairs = [
        ("/email/INBOX/msg1.email.json", "foo foo\nfoo bar\nbaz\n"),
        ("/email/INBOX/msg2.email.json", "bar\nbaz\n"),
    ]
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=pairs),
    ):
        stdout, io = await _grep_server_side(
            accessor,
            "INBOX",
            "foo",
            [
                PathSpec(resource_path=mount_key("/email/INBOX", "/email"),
                         virtual="/email/INBOX",
                         directory="/email/INBOX")
            ],
            c=True,
        )
    assert await materialize(stdout) == (b"/email/INBOX/msg1.email.json:2\n"
                                         b"/email/INBOX/msg2.email.json:0\n")
    assert io.exit_code == 0

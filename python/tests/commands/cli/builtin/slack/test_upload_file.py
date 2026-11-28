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

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.commands.cli.builtin.slack import SLACK, upload_file
from mirage.commands.config import Context
from mirage.core.slack.config import SlackConfig
from mirage.io.types import materialize
from mirage.types import PathSpec
from tests.fixtures.slack_workspace import COMPLETE

ACCESSOR = SlackAccessor(SlackConfig(token="xoxb-test"))


class _Files:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files

    async def read(self, path: PathSpec) -> bytes:
        try:
            return self.files[path.virtual]
        except KeyError:
            raise FileNotFoundError(2, "No such file", path.virtual) from None


def _upload_ctx(vfs, **flags) -> Context:
    spec = next(s for s in SLACK.spec.subcommands if s.name == "upload-file")
    return Context(flags=flags, spec=spec, vfs=vfs)


@pytest.mark.asyncio
async def test_upload_file_shares_the_workspace_file(slack_workspace):
    # The bytes come from the workspace's own file, shared in a thread.
    lunch = "1762214460.000001"
    vfs = _Files({"/tmp/reply.wav": b"RIFF"})
    out, io = await upload_file(
        slack_workspace.accessor(),
        [],
        [],
        _upload_ctx(
            vfs,
            channel="C1",
            file=PathSpec.from_str_path("/tmp/reply.wav"),
            initial_comment="here",
            thread_ts=lunch,
        ),
    )
    assert io.exit_code == 0
    [shared] = json.loads(await materialize(out))["files"]
    assert await slack_workspace.run.bodies("POST", COMPLETE) == [
        {
            "files": [{"id": shared["id"], "title": "reply.wav"}],
            "channel_id": "C1",
            "initial_comment": "here",
            "thread_ts": lunch,
        }
    ]
    assert (
        await slack_workspace.run.read(f"/files/download/{shared['id']}")
        == b"RIFF"
    )


@pytest.mark.asyncio
async def test_upload_file_names_a_missing_file():
    with pytest.raises(ValueError, match="read /tmp/nope.wav: No such file"):
        await upload_file(
            ACCESSOR,
            [],
            [],
            _upload_ctx(
                _Files({}),
                channel="C1",
                file=PathSpec.from_str_path("/tmp/nope.wav"),
            ),
        )

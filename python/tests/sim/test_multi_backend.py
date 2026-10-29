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

from tests.core.discord.conftest import FakeDiscordApi
from tests.core.slack.conftest import FakeSlack
from tests.e2e.gdrive_mock import FakeGDrive
from tests.fixtures.github_mock import MOCK_BLOBS, MOCK_TREE
from tests.sim.seam import Exponential, Match
from tests.sim.world import Sim, simulate


def test_sim_gdrive():
    """Verify Google Drive operates in virtual time with deterministic latency and trace."""
    fake_gd = FakeGDrive()
    fake_gd.add_file("notes.txt", b"meeting notes in google drive\n")

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        res_ls = await actor.sh("ls /gd")
        assert res_ls.exit_code == 0
        assert b"notes.txt" in res_ls.stdout

        res_cat = await actor.sh("cat /gd/notes.txt")
        assert res_cat.exit_code == 0
        assert res_cat.stdout == b"meeting notes in google drive\n"

    _, trace = simulate(
        scenario,
        gdrive=fake_gd,
        latency=Exponential(seed=123, mean=0.01),
    )

    ops = [e.op for e in trace.served()]
    assert "list_files" in ops or "list_children" in ops
    assert "capture_file_metadata" in ops or "get_file" in ops or "download_file" in ops


def test_sim_slack():
    """Verify Slack operates in virtual time with deterministic latency and trace."""
    fake_slack = FakeSlack()

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        res_ls = await actor.sh("ls /slack/channels")
        assert res_ls.exit_code == 0

        res_cat = await actor.sh(
            "cat /slack/channels/general__C1/2025-11-03/chat.jsonl"
        )
        assert res_cat.exit_code == 0
        assert b"the deploy is done at acme" in res_cat.stdout

        res_user = await actor.sh("cat /slack/users/ana__U1.json")
        assert res_user.exit_code == 0
        assert b"Ana Lima" in res_user.stdout

    _, trace = simulate(
        scenario,
        slack=fake_slack,
        latency=Exponential(seed=456, mean=0.01),
    )

    ops = [e.op for e in trace.served()]
    assert "conversations.list" in ops
    assert "conversations.history" in ops
    assert "users.info" in ops


def test_sim_multi_backend_cross_mount():
    """Verify S3, Google Drive, and Slack coexisting in a single workspace under virtual time."""
    fake_gd = FakeGDrive()
    fake_gd.add_file("report.txt", b"quarterly report\n")
    fake_slack = FakeSlack()
    s3_files = {"s3_data.txt": b"s3 cloud data\n"}

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")

        # Read across all three backends
        res_s3 = await actor.sh("cat /s3/s3_data.txt")
        assert res_s3.exit_code == 0
        assert res_s3.stdout == b"s3 cloud data\n"

        res_gd = await actor.sh("cat /gd/report.txt")
        assert res_gd.exit_code == 0
        assert res_gd.stdout == b"quarterly report\n"

        res_slack = await actor.sh(
            "cat /slack/channels/general__C1/2025-11-03/chat.jsonl"
        )
        assert res_slack.exit_code == 0
        assert b"the deploy is done at acme" in res_slack.stdout

    _, trace = simulate(
        scenario,
        files=s3_files,
        gdrive=fake_gd,
        slack=fake_slack,
        latency=Exponential(seed=789, mean=0.005),
    )

    ops = {e.op for e in trace.served()}
    # S3 op
    assert "get_object" in ops
    # Slack ops
    assert "conversations.history" in ops
    # GDrive ops
    assert any("file" in op or "drive" in op for op in ops)


def test_sim_github():
    """Verify GitHub tree exploration and blob reads under virtual time."""
    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        res_ls = await actor.sh("ls /github")
        assert res_ls.exit_code == 0
        assert b"README.md" in res_ls.stdout

        res_cat = await actor.sh("cat /github/README.md")
        assert res_cat.exit_code == 0
        assert b"# Mock Repo" in res_cat.stdout

    _, trace = simulate(
        scenario,
        github=True,
        latency=Exponential(seed=101, mean=0.01),
    )

    ops = [e.op for e in trace.served()]
    assert "fetch_default_branch" in ops
    assert "fetch_tree" in ops
    assert "read_bytes" in ops


def test_sim_dropbox():
    """Verify Dropbox listing, download, and upload under virtual time."""
    dbx_files = {"/doc.txt": b"hello dropbox\n"}

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")

        # List Dropbox files
        res_ls = await actor.sh("ls /dbx")
        assert res_ls.exit_code == 0
        assert b"doc.txt" in res_ls.stdout

        # Read existing file
        res_cat = await actor.sh("cat /dbx/doc.txt")
        assert res_cat.exit_code == 0
        assert res_cat.stdout == b"hello dropbox\n"

        # Write new file to Dropbox
        res_write = await actor.sh("printf 'new content\n' > /dbx/new.txt")
        assert res_write.exit_code == 0

        # Read back written file
        res_read_new = await actor.sh("cat /dbx/new.txt")
        assert res_read_new.exit_code == 0
        assert res_read_new.stdout == b"new content\n"

        # Nonexistent folder should be refused
        res_missing = await actor.sh("ls /dbx/nonexistent")
        assert res_missing.exit_code != 0

    _, trace = simulate(
        scenario,
        dropbox=dbx_files,
        latency=Exponential(seed=202, mean=0.01),
    )

    ops = [e.op for e in trace.served()]
    assert "dropbox:/files/list_folder" in ops
    assert "dropbox:download" in ops
    assert "dropbox:upload" in ops


def test_sim_discord():
    """Verify Discord guild, channel listing and chat history under virtual time."""
    fake_discord = FakeDiscordApi()

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")

        # List guilds
        res_ls = await actor.sh("ls /discord")
        assert res_ls.exit_code == 0
        assert b"My Server__G001" in res_ls.stdout

        # Read chat history
        res_cat = await actor.sh(
            "cat /discord/My\\ Server__G001/channels/general__C001/2024-01-15/chat.jsonl"
        )
        assert res_cat.exit_code == 0
        assert b"hello" in res_cat.stdout
        assert b"alice" in res_cat.stdout

        # Read attachment stream
        res_att = await actor.sh(
            "cat /discord/My\\ Server__G001/channels/general__C001/2024-01-15/files/kept__A1.txt"
        )
        assert res_att.exit_code == 0
        assert res_att.stdout == b"0123456789"

    _, trace = simulate(
        scenario,
        discord=fake_discord,
        latency=Exponential(seed=303, mean=0.01),
    )

    ops = [e.op for e in trace.served()]
    assert "list_guilds" in ops
    assert "list_channels" in ops
    assert "list_messages_for_day" in ops
    assert "download_file" in ops


def test_sim_ram_and_cross_mount():
    """Verify in-memory POSIX RamVFS (/ram) and cross-mount transfers with S3."""
    s3_files = {"s3_source.txt": b"source data from S3\n"}

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")

        # Fast RAM writes & reads
        res_w = await actor.sh("printf 'in-memory buffer\n' > /ram/local.txt")
        assert res_w.exit_code == 0

        res_r = await actor.sh("cat /ram/local.txt")
        assert res_r.exit_code == 0
        assert res_r.stdout == b"in-memory buffer\n"

        # Cross-mount: copy from S3 into RAM
        res_cp1 = await actor.sh("cp /s3/s3_source.txt /ram/cached_source.txt")
        assert res_cp1.exit_code == 0

        res_r_cached = await actor.sh("cat /ram/cached_source.txt")
        assert res_r_cached.exit_code == 0
        assert res_r_cached.stdout == b"source data from S3\n"

        # Cross-mount: copy from RAM back into S3
        res_cp2 = await actor.sh("cp /ram/local.txt /s3/ram_backup.txt")
        assert res_cp2.exit_code == 0

        res_r_backup = await actor.sh("cat /s3/ram_backup.txt")
        assert res_r_backup.exit_code == 0
        assert res_r_backup.stdout == b"in-memory buffer\n"

    _, trace = simulate(
        scenario,
        files=s3_files,
        ram=True,
        latency=Exponential(seed=404, mean=0.005),
    )

    ops = {e.op for e in trace.served()}
    # S3 was read and written
    assert "get_object" in ops
    assert "put_object" in ops


def test_sim_hold_non_s3_backend():
    """Verify sim.hold works cleanly with non-S3 ops and extracted keys."""
    fake_discord = FakeDiscordApi()

    async def scenario(sim: Sim):
        # Hold list_channels for guild G001
        hold = sim.hold(Match(op="list_channels", key="G001"))
        actor = await sim.workspace().actor("a")

        # Run command in background task
        task = sim.loop.create_task(
            actor.sh("ls /discord/My\\ Server__G001/channels")
        )
        await sim.settle()
        assert not task.done(), "request should be held before fake executes"

        # Release hold
        hold.release()
        res = await task
        assert res.exit_code == 0
        assert b"general__C001" in res.stdout

    simulate(
        scenario,
        discord=fake_discord,
    )



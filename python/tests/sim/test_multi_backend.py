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

import asyncio
from datetime import datetime, timezone

from mirage.cache.index.ram import ListingCheckStore
from mirage.core.discord.history import snowflake_at
from tests.core.discord.conftest import DAY, FakeDiscordApi
from tests.core.slack.conftest import FakeSlack
from tests.e2e.gdrive_mock import FakeGDrive
from tests.sim.seam import Exponential, Leg, Match
from tests.sim.trace import StepRef
from tests.sim.world import Sim, simulate


def test_sim_gdrive():
    """Verify Google Drive operates in virtual time with deterministic
    latency and trace."""
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
    assert (
        "capture_file_metadata" in ops
        or "get_file" in ops
        or "download_file" in ops
    )


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
    """Verify S3, Google Drive, and Slack coexisting in a single workspace
    under virtual time."""
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
        dpath = "/discord/My\\ Server__G001/channels/general__C001/2024-01-15"
        res_cat = await actor.sh(f"cat {dpath}/chat.jsonl")
        assert res_cat.exit_code == 0
        assert b"hello" in res_cat.stdout
        assert b"alice" in res_cat.stdout

        # Read attachment stream
        res_att = await actor.sh(f"cat {dpath}/files/kept__A1.txt")
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
    assert "download_file_stream" in ops


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


def test_sim_dropbox_spooled_upload():
    """Verify streamed writer input (ByteSpool) uploads cleanly from S3 to Dropbox."""
    s3_files = {
        "large_blob.bin": b"hello streamed world from s3 to dropbox" * 100
    }
    dbx_files: dict[str, bytes] = {}

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        res = await actor.sh("cp /s3/large_blob.bin /dbx/uploaded.bin")
        assert res.exit_code == 0

        res_cat = await actor.sh("cat /dbx/uploaded.bin")
        assert res_cat.exit_code == 0
        assert res_cat.stdout == s3_files["large_blob.bin"]

    _, trace = simulate(
        scenario,
        files=s3_files,
        dropbox=dbx_files,
        latency=Exponential(seed=111, mean=0.005),
    )

    ops = [e.op for e in trace.served()]
    assert "get_object" in ops
    assert "dropbox:upload" in ops


def test_sim_dropbox_stale_write_refused():
    """Verify stale write refusal on Dropbox when a concurrent write
    advances the rev."""
    dbx_files = {"/shared.txt": b"initial content\n"}

    async def scenario(sim: Sim):
        ws1 = sim.workspace()
        ws2 = sim.workspace()
        a1 = await ws1.actor("a1")
        a2 = await ws2.actor("a2")

        # Both actors observe initial revision
        res_r1 = await a1.sh("cat /dbx/shared.txt")
        assert res_r1.exit_code == 0
        res_r2 = await a2.sh("cat /dbx/shared.txt")
        assert res_r2.exit_code == 0

        # Hold a1's upload
        hold = sim.hold(Match(op="dropbox:upload", key="/shared.txt"))
        task_a1 = a1.start("printf 'stale update\n' > /dbx/shared.txt")
        await sim.settle()
        assert not task_a1.done()

        # a2 commits a write, updating the file rev
        res_w2 = await a2.sh("printf 'winner update\n' > /dbx/shared.txt")
        assert res_w2.exit_code == 0

        # Release a1's upload; must fail due to rev conflict
        hold.release()
        res_a1 = await task_a1
        assert res_a1.exit_code != 0

        # File content reflects a2's win
        res_final = await a2.sh("cat /dbx/shared.txt")
        assert res_final.stdout == b"winner update\n"

    simulate(
        scenario,
        dropbox=dbx_files,
    )


def test_sim_dropbox_mkdir_mv_cp_and_empty_folder():
    """Verify Dropbox mkdir, cp, mv, and empty folder survival after file deletion."""
    dbx_files = {"/seed.txt": b"payload data\n"}

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")

        # mkdir
        res_mk = await actor.sh("mkdir /dbx/folder")
        assert res_mk.exit_code == 0

        # cp
        res_cp = await actor.sh("cp /dbx/seed.txt /dbx/folder/c.txt")
        assert res_cp.exit_code == 0

        # mv
        res_mv = await actor.sh("mv /dbx/folder/c.txt /dbx/folder/m.txt")
        assert res_mv.exit_code == 0

        res_cat = await actor.sh("cat /dbx/folder/m.txt")
        assert res_cat.exit_code == 0
        assert res_cat.stdout == b"payload data\n"

        # rm file
        res_rm = await actor.sh("rm /dbx/folder/m.txt")
        assert res_rm.exit_code == 0

        # Empty folder still exists
        res_ls = await actor.sh("ls /dbx/folder")
        assert res_ls.exit_code == 0
        assert res_ls.stdout == b""

    _, trace = simulate(
        scenario,
        dropbox=dbx_files,
    )

    ops = [e.op for e in trace.served()]
    assert "dropbox:/files/create_folder_v2" in ops
    assert "dropbox:/files/copy_v2" in ops
    assert "dropbox:/files/move_v2" in ops
    assert "dropbox:/files/delete_v2" in ops


def test_sim_dropbox_download_window():
    """Verify Dropbox downloading with byte window (offset and size)."""
    dbx_files = {"/windowed.txt": b"0123456789abcdefghijklmnopqrstuvwxyz"}

    async def scenario(sim: Sim):
        ws = sim.workspace()
        mount = next(m for m in ws.workspace.mounts() if m.prefix == "/dbx/")
        # Read slice [10 : 25]
        slice_bytes = await mount.call(
            "read", "/windowed.txt", offset=10, size=15
        )
        assert slice_bytes == b"abcdefghijklmno"

    _, trace = simulate(
        scenario,
        dropbox=dbx_files,
    )

    ops = [e.op for e in trace.served()]
    assert "dropbox:download" in ops


def test_sim_github_batched_graphql_read():
    """Verify multi-file reads on GitHub stay batched in graphql_data with
    valid git blob shas."""

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        # List to prime directory index
        await actor.sh("ls /github/src")
        # Read multiple files: first file streams, subsequent files batched
        # via read_many
        res = await actor.sh(
            "cat /github/src/__init__.py /github/src/main.py /github/src/utils.py"
        )
        assert res.exit_code == 0
        assert b"from src.utils import helper" in res.stdout
        assert b"def helper():" in res.stdout

    _, trace = simulate(
        scenario,
        github=True,
    )

    ops = [e.op for e in trace.served()]
    assert "graphql_data" in ops
    read_bytes_ops = [e for e in trace.served() if e.op == "read_bytes"]
    assert len(read_bytes_ops) == 1


def test_sim_github_cold_stat_no_real_io():
    """Verify cold stat, head check, and point lookup on GitHub route through
    seam without real network I/O."""

    async def scenario(sim: Sim):
        ws = sim.workspace()
        actor = await ws.actor("a")

        # Head version check via ListingCheckStore calls fetch_head through seam
        mount = next(
            m for m in ws.workspace.mounts() if m.prefix == "/github/"
        )
        root_stat = await mount.call("stat", "/", index=ListingCheckStore())
        assert root_stat.fingerprint == "mock-head-sha"

        # Cold file stat via shell calls fetch_dir_page through seam
        res = await actor.sh("wc -c /github/README.md")
        assert res.exit_code == 0
        assert b"README.md" in res.stdout

    _, trace = simulate(
        scenario,
        github=True,
    )

    ops = [e.op for e in trace.served()]
    assert "fetch_head" in ops
    assert "fetch_dir_page" in ops


def slow_stream_back(
    step: StepRef | None, op: str, key: str, nth: int, leg: Leg
) -> float:
    return 1.0 if leg is Leg.BACK and op == "download_file_stream" else 0.0


def test_sim_gdrive_stream_read_inside_request():
    """Verify a Drive stream is read when its request is served, so a
    write while the answer is on its way back does not change the bytes."""
    fake_gd = FakeGDrive()
    fake_gd.add_file("big.txt", b"old" * 40)

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        await actor.sh("ls /gd")
        task = actor.start("cat /gd/big.txt")
        await asyncio.sleep(0.5)
        fake_gd.add_file("big.txt", b"new" * 40)
        res = await task
        assert res.exit_code == 0
        assert res.stdout == b"old" * 40

    simulate(scenario, gdrive=fake_gd, latency=slow_stream_back)


def test_sim_gdrive_hold_matches_positional_file_id():
    """Verify a hold keyed on a Drive file id matches a request the
    client sent with a positional argument."""
    fake_gd = FakeGDrive()
    file_id = fake_gd.add_file("notes.txt", b"notes\n")

    async def scenario(sim: Sim):
        hold = sim.hold(
            Match(op="capture_file_metadata", key=file_id),
        )
        actor = await sim.workspace().actor("a")
        await actor.sh("ls /gd")
        task = actor.start("cat /gd/notes.txt")
        await sim.settle()
        assert hold.reached
        hold.release()
        res = await task
        assert res.stdout == b"notes\n"

    simulate(scenario, gdrive=fake_gd)


def test_sim_gdrive_native_read_takes_virtual_time():
    """Verify a native Doc read is a traced request that waits on the
    latency like any other."""
    fake_gd = FakeGDrive()
    fake_gd.add_file(
        "plan", b"plan body", mime="application/vnd.google-apps.document"
    )

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        await actor.sh("ls /gd")
        started = sim.loop.time()
        res = await actor.sh("cat /gd/plan.gdoc.json")
        assert res.exit_code == 0
        assert sim.loop.time() > started

    _, trace = simulate(
        scenario,
        gdrive=fake_gd,
        latency=Exponential(seed=7, mean=0.01),
    )
    assert "read_doc" in [e.op for e in trace.served()]


posted = datetime(2024, 1, 15, 12, tzinfo=timezone.utc).timestamp()


class _DatedDiscord(FakeDiscordApi):
    async def list_messages_for_day(
        self, accessor, channel_id, date_str, scope
    ):
        if channel_id != "C001" or date_str != DAY:
            return []
        return [
            {
                "id": str(snowflake_at(posted)),
                "content": "hello",
                "author": {"username": "alice"},
            }
        ]


def test_sim_discord_follow_reads_through_seam():
    """Verify ``tail -f`` on a channel day asks the seam, not Discord; the
    follow runs until the line's virtual timeout."""
    fake_discord = _DatedDiscord()

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        base = "/discord/My\\ Server__G001/channels/general__C001"
        await actor.sh(f"ls {base}")
        res = await actor.sh(f"tail -f -n 1 {base}/{DAY}/chat.jsonl")
        assert b"hello" in res.stdout
        assert b"real I/O" not in res.stderr

    _, trace = simulate(scenario, discord=fake_discord)
    ops = [e.op for e in trace.served()]
    assert ops.count("list_messages_for_day") >= 2


def test_sim_slack_stream_hold_uses_stream_op():
    """Verify an attachment stream is held by ``download_file_stream``."""
    fake_slack = FakeSlack()

    async def scenario(sim: Sim):
        actor = await sim.workspace().actor("a")
        day = "/slack/channels/general__C1/2025-11-05"
        await actor.sh(f"ls {day}/files")
        hold = sim.hold(Match(op="download_file_stream"))
        task = actor.start(f"cat {day}/files/plan__F1.txt")
        await sim.settle()
        assert hold.reached
        hold.release()
        res = await task
        assert res.stdout == b"plan\n"

    simulate(scenario, slack=fake_slack)


def test_sim_ram_timestamps_follow_virtual_time():
    """Verify RAM writes are stamped from the simulated clock, so two runs
    agree on every stamp."""

    def run_once() -> bytes:
        async def scenario(sim: Sim) -> bytes:
            actor = await sim.workspace().actor("a")
            await actor.sh("printf 'x' > /ram/a.txt")
            await asyncio.sleep(5)
            await actor.sh("printf 'y' > /ram/b.txt")
            res = await actor.sh("stat -c '%n %Y' /ram/a.txt /ram/b.txt")
            assert res.exit_code == 0
            return res.stdout

        out, _ = simulate(scenario, ram=True)
        return out

    first = run_once()
    second = run_once()
    assert first == second
    stamps = [int(line.split()[1]) for line in first.splitlines()]
    assert stamps[1] - stamps[0] == 5

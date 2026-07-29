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
import json

from mirage import MountMode, Workspace
from mirage.observe.store import RAMObserverStore
from mirage.resource.ram import RAMResource


def test_workspace_creates_default_observer():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    assert ws.observer is not None
    assert isinstance(ws.observer.store, RAMObserverStore)


def test_workspace_custom_observe_store():
    obs_store = RAMObserverStore()
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        observe=obs_store,
    )
    assert ws.observer.store is obs_store


def test_logs_populated_after_execute():
    obs_store = RAMObserverStore()
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   observe=obs_store)
    asyncio.run(ws.execute("echo hello > /data/test.txt"))
    session_files = [k for k in obs_store.files if k.endswith(".jsonl")]
    assert len(session_files) >= 1
    data = obs_store.files[session_files[0]]
    lines = data.decode().strip().split("\n")
    assert len(lines) >= 1
    entry = json.loads(lines[-1])
    assert entry["type"] == "command"


def test_logs_contain_op_records():
    obs_store = RAMObserverStore()
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   observe=obs_store)
    asyncio.run(ws.execute("echo hello > /data/test.txt"))
    asyncio.run(ws.execute("cat /data/test.txt"))
    session_files = [k for k in obs_store.files if k.endswith(".jsonl")]
    data = obs_store.files[session_files[0]]
    lines = data.decode().strip().split("\n")
    types = {json.loads(line)["type"] for line in lines}
    assert "op" in types
    assert "command" in types


def test_observer_store_not_mounted():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("echo hi > /data/f.txt"))
    result = asyncio.run(ws.execute("ls /.sessions"))
    assert result.exit_code != 0
    prefixes = {m.prefix for m in ws._registry.mounts()}
    assert prefixes == {"/", "/data/", "/dev/", "/.bash_history/"}


# The tests below assert the recorded event shape on the real execute path.
# The rest of the observe suite builds entries by hand, so a regression in the
# wiring from a command to its event would not be caught there, and the
# /.bash_history and `history` views render fine without these fields.
def test_execute_records_exit_code_and_cwd():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("echo hello > /data/test.txt"))
    asyncio.run(ws.execute("cat /data/missing.txt"))
    commands = asyncio.run(ws.history())
    assert len(commands) == 2
    assert all("exit_code" in e for e in commands)
    assert all("cwd" in e for e in commands)
    assert [e["exit_code"] for e in commands] == [0, 1]


def test_execute_records_op_source():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("echo hello > /data/test.txt"))
    asyncio.run(ws.execute("cat /data/test.txt"))
    events = asyncio.run(ws.observer.events())
    ops = [e for e in events if e["type"] == "op"]
    assert ops
    assert all("source" in e for e in ops)
    assert "/data/test.txt" in {e["path"] for e in ops if e["op"] == "read"}


def test_execute_records_op_path_per_mount():
    ws = Workspace({
        "/s3/": RAMResource(),
        "/db/": RAMResource()
    },
                   mode=MountMode.WRITE)
    for line in ("echo one > /s3/report.json", "echo two > /db/report.json",
                 "cat /s3/report.json", "cat /db/report.json",
                 "cp /s3/report.json /db/copy.json"):
        asyncio.run(ws.execute(line))
    events = asyncio.run(ws.observer.events())
    ops = [(e["op"], e["path"]) for e in events if e["type"] == "op"]
    assert ops == [
        ("write", "/s3/report.json"),
        ("write", "/db/report.json"),
        ("read", "/s3/report.json"),
        ("read", "/db/report.json"),
        ("read", "/s3/report.json"),
        ("write", "/db/copy.json"),
    ]


def test_execute_records_every_event_type():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("echo hello > /data/test.txt"))
    asyncio.run(ws.execute("history -s synthetic"))
    asyncio.run(ws.execute("history -d 1"))
    asyncio.run(ws.execute("history -c"))
    events = asyncio.run(ws.observer.events())
    assert {"clear", "command", "delete", "op"} <= {e["type"] for e in events}

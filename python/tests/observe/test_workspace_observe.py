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

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

import sys
import threading

from mirage.vfs.ram.store import RAMFiles, RAMStore


def test_memory_store_holds_state():
    store = RAMStore()
    assert store.files == {}
    assert store.dirs == {"/"}
    assert store.modified == {}


def test_memory_store_custom_state():
    files = {"/a": b"hello"}
    dirs = {"/", "/dir"}
    modified = {"/a": "2024-01-01"}
    store = RAMStore(files=files, dirs=dirs, modified=modified)
    assert store.files["/a"] == b"hello"
    assert "/dir" in store.dirs


def test_a_read_on_another_thread_never_drops_a_splice():
    files = RAMFiles()
    files["/f"] = b""
    done = threading.Event()

    def read() -> None:
        while not done.is_set():
            files["/f"]

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    reader = threading.Thread(target=read)
    reader.start()
    try:
        for _ in range(5000):
            files.splice("/f", files.size("/f"), b"x")
    finally:
        done.set()
        reader.join()
        sys.setswitchinterval(interval)
    assert files["/f"] == b"x" * 5000

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


import threading
import time

import pytest

from mirage.vfs.sql.postgres import PostgresSqlDriver


# A database that cannot be reached raises from the statement, and leaves
# no thread of the driver running behind it.
def test_an_unreachable_database_leaves_no_thread():
    driver = PostgresSqlDriver("postgres://mirage:mirage@127.0.0.1:1/none")
    for _ in range(2):
        with pytest.raises(OSError):
            driver.query("SELECT 1")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(
        t.name == "mirage-postgres" for t in threading.enumerate()
    ):
        time.sleep(0.01)
    assert not any(t.name == "mirage-postgres" for t in threading.enumerate())
    assert driver.location == "postgres://127.0.0.1:1/none"
    driver.close()

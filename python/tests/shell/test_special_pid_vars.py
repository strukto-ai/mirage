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

import os


def test_dollar_dollar_is_process_id(shell):
    assert shell.mirage("echo $$") == f"{os.getpid()}\n"


def test_dollar_bang_empty_without_background_job(shell):
    assert shell.mirage("echo [$!]") == "[]\n"


def test_dollar_bang_is_last_background_job_id(shell):
    out = shell.mirage("sleep 0.05 & echo bg=$!")
    assert out == "bg=1\n"


def test_wait_on_dollar_bang(shell):
    code, out, _ = shell.mirage_result("sleep 0.05 & wait $!; echo waited=$?")
    assert code == 0
    assert out == "waited=0\n"


def test_dollar_bang_does_not_leak_from_subshell(shell):
    out = shell.mirage("(sleep 0.05 &) ; echo [$!]")
    assert out == "[]\n"

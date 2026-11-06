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

from mirage.shell.voice import shell_voice, use_voice


def test_outside_a_shell_the_voice_is_bash():
    assert shell_voice() == "bash: "


def test_the_installed_reader_leads_every_diagnostic():
    saved = use_voice(lambda: "env.sh: line 2: ")
    try:
        assert shell_voice() == "env.sh: line 2: "
    finally:
        use_voice(saved)

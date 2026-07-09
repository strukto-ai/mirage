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

from mirage.workspace.route import (SHELL_CONSUMERS, Consumer, WordPolicy,
                                    word_policy)


def test_shell_consumers_get_shell_policy():
    for consumer in SHELL_CONSUMERS:
        assert word_policy(consumer) is WordPolicy.SHELL


def test_mount_gets_mount_policy():
    assert word_policy(Consumer.MOUNT) is WordPolicy.MOUNT


def test_unknown_gets_mount_policy():
    # Unknown names keep patterns intact: nothing resolves their words,
    # the command fails before any backend I/O.
    assert word_policy(Consumer.UNKNOWN) is WordPolicy.MOUNT


def test_every_consumer_has_a_policy():
    for consumer in Consumer:
        assert isinstance(word_policy(consumer), WordPolicy)

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

from enum import Enum, auto


class Consumer(Enum):
    """The layer that consumes a command: a command belongs to the layer
    whose state it mutates.

    The verdict drives both the dispatch branch and the word policy:
    SESSION / NAMESPACE / FUNCTION words are shell-resolved (bash
    contract: programs receive matches, never patterns); MOUNT words
    keep glob patterns intact for backend pushdown; UNKNOWN words are
    never resolved (the command fails, backend I/O for it is waste).
    """

    SESSION = auto()
    NAMESPACE = auto()
    FUNCTION = auto()
    MOUNT = auto()
    UNKNOWN = auto()


SHELL_CONSUMERS = frozenset({
    Consumer.SESSION,
    Consumer.NAMESPACE,
    Consumer.FUNCTION,
})


class WordPolicy(Enum):
    """How a command's words are resolved, derived from its consumer.

    SHELL: the shell resolves globs before the command runs and spec
    hints are ignored; bash expands `echo /data/*.txt` no matter what
    echo does with its arguments. NAMESPACE and FUNCTION consumers get
    the same treatment (programs receive matches, never patterns).

    MOUNT: the command's spec classifies words (TEXT stays literal,
    PATH resolves) and glob PathSpecs stay intact for backend pushdown.
    UNKNOWN names also land here: nothing resolves their words, the
    command fails before any backend I/O.
    """

    SHELL = auto()
    MOUNT = auto()


def word_policy(consumer: Consumer) -> WordPolicy:
    """Map a consumer to its word policy.

    Args:
        consumer (Consumer): the layer that consumes the command.
    """
    if consumer in SHELL_CONSUMERS:
        return WordPolicy.SHELL
    return WordPolicy.MOUNT

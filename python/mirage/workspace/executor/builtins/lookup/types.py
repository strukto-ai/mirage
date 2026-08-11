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

from enum import StrEnum


class NameKind(StrEnum):
    """What a command name resolves to, spelled as ``type -t`` prints it.

    bash's ``-t`` vocabulary is alias/keyword/function/builtin/file.
    mirage has no aliases and no external binaries, so ``file`` never
    applies and every mirage-native runnable name that is not a function
    would collapse into ``builtin``. ``cli`` is a sixth word rather than
    a reuse of ``file``: reusing it would promise ``type -p`` a path to
    print, and there is none.

    Members are ordered as ``type -a`` prints them, which is also the
    order the layers resolve in.
    """
    KEYWORD = "keyword"
    FUNCTION = "function"
    CLI = "cli"
    BUILTIN = "builtin"

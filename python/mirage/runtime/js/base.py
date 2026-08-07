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

from typing import ClassVar

from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import Language


class JsRuntime(LanguageRuntime):
    """The js tier: every runtime that interprets JavaScript source.

    Groups the engines behind the node/js commands (quickjs today), so
    ``language`` is declared once and js-tier behavior has one home. A
    new JavaScript engine subclasses this, not LanguageRuntime.
    """

    language: ClassVar[Language] = "js"

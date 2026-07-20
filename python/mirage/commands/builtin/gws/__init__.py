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

from mirage.commands.builtin.gws.factory import make_gws_api_commands
from mirage.commands.builtin.gws.methods import GWS_METHODS, GwsMethod

GWS_DRIVE_API_COMMANDS = make_gws_api_commands("drive")
GWS_DOCS_API_COMMANDS = make_gws_api_commands("docs")
GWS_SHEETS_API_COMMANDS = make_gws_api_commands("sheets")
GWS_SLIDES_API_COMMANDS = make_gws_api_commands("slides")
GWS_GMAIL_API_COMMANDS = make_gws_api_commands("gmail")

__all__ = [
    "GWS_METHODS",
    "GwsMethod",
    "GWS_DRIVE_API_COMMANDS",
    "GWS_DOCS_API_COMMANDS",
    "GWS_SHEETS_API_COMMANDS",
    "GWS_SLIDES_API_COMMANDS",
    "GWS_GMAIL_API_COMMANDS",
    "make_gws_api_commands",
]

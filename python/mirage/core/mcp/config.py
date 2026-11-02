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

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, SecretStr, model_validator

HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
HEADER_VALUE = re.compile(r"[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?")


class MCPAuth(BaseModel):
    """How a request to the server authenticates: one header.

    Args:
        type (Literal["bearer", "header"]): ``bearer`` sends
            ``Authorization: Bearer <token>``; ``header`` sends
            ``<name>: <token>``.
        token (SecretStr): the credential.
        name (str | None): the header ``header`` sends; refused for
            ``bearer``.
    """

    model_config = ConfigDict(
        frozen=True, extra="forbid", hide_input_in_errors=True
    )

    type: Literal["bearer", "header"]
    token: SecretStr
    name: str | None = None

    @model_validator(mode="after")
    def _v_header(self) -> "MCPAuth":
        if not HEADER_VALUE.fullmatch(self.token.get_secret_value()):
            raise ValueError("the token holds a character no header carries")
        if self.type == "bearer" and self.name is not None:
            raise ValueError(
                "bearer auth sends Authorization; it takes no name"
            )
        if self.type == "header":
            if self.name is None:
                raise ValueError("header auth needs the header's name")
            if not HEADER_NAME.fullmatch(self.name):
                raise ValueError(f"{self.name!r} is not a header name")
        return self


class MCPConfig(BaseModel):
    """Where an MCP server is and how to authenticate to it.

    Args:
        url (str): the server's streamable-HTTP endpoint.
        auth (MCPAuth | None): the header every request carries; none
            for a public server.
    """

    model_config = ConfigDict(
        frozen=True, extra="forbid", hide_input_in_errors=True
    )

    url: str
    auth: MCPAuth | None = None

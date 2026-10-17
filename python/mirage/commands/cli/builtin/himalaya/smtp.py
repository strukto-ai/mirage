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

from email.message import Message
from email.parser import BytesParser
from email.policy import default as default_policy

import aiosmtplib

from mirage.core.email.config import EmailConfig
from mirage.vfs.secrets import reveal_secret

IMPLICIT_TLS_PORT = 465


async def send_raw(config: EmailConfig, raw: bytes) -> Message:
    """Push an RFC 5322 message through the account's SMTP path.

    Sending lives with the CLI rather than in ``core/email`` because
    the email mount is read-only: no filesystem operation reaches
    SMTP, and himalaya is the only thing that sends.

    Args:
        config (EmailConfig): SMTP credentials and host.
        raw (bytes): the complete RFC 5322 message.

    Returns:
        Message: the parsed message, so callers can report its headers.
    """
    message = BytesParser(policy=default_policy).parsebytes(raw)
    # Port 465 speaks TLS from its first byte (RFC 8314's implicit TLS),
    # which aiosmtplib only does under use_tls; it defaults to plaintext on
    # every port. Any other port connects in plaintext, and start_tls=None
    # upgrades it when the server advertises STARTTLS (and never on a
    # connection that is TLS already). That is nodemailer's
    # `secure: port === 465` in the TS backend, which upgrades the same way
    # when secure is false.
    await aiosmtplib.send(
        message,
        hostname=config.smtp_host,
        port=config.smtp_port,
        username=config.username,
        password=reveal_secret(config.password),
        use_tls=config.smtp_port == IMPLICIT_TLS_PORT,
        start_tls=None,
    )
    return message

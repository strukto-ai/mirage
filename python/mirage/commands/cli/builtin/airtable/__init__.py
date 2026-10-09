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

from mirage.commands.cli.builtin.airtable import reads, writes
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.airtable.config import AirtableConfig

BASE_OPTION = Argument("--base", required=True, help="Base ID (app...)")

TABLE_OPTION = Argument("--table", required=True, help="Table ID or name")

FIELDS_OPTION = Argument(
    "--fields",
    help="Cell values as a JSON object keyed by field name",
)

TYPECAST_OPTION = Argument(
    "--typecast",
    action="store_true",
    help="Let Airtable convert string values to the field types",
)

RECORD = Argument("RECORD", nargs="?")

CREATE_EPILOG = (
    "Without --fields, reads records.jsonl lines from stdin "
    'and creates one\nrecord per line from its "fields"; '
    "computed fields are dropped."
)

UPDATE_EPILOG = (
    "Without RECORD --fields, reads records.jsonl lines from "
    'stdin and patches\neach "record_id" with its '
    '"fields"; computed fields are dropped.'
)

DELETE_EPILOG = (
    "Without RECORD operands, reads records.jsonl lines from "
    'stdin and deletes\neach "record_id".'
)

# The airtable program tree. Bases, tables and records are addressed by
# the ids the mount prints after the last "__" of a directory name; a
# write takes one record from flags or many as JSONL on stdin, the shape
# records.jsonl holds. Install with an AirtableConfig.
AIRTABLE = CLI(
    spec=CommandSpec(
        name="airtable",
        description="Airtable Web API client",
        subcommands=(
            CommandSpec(
                name="base",
                description="Read bases",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List the bases the token reaches as JSON",
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one base and its tables (base.json)",
                        arguments=(Argument("BASE", nargs="?"),),
                    ),
                ),
            ),
            CommandSpec(
                name="table",
                description="Read table schemas",
                subcommands=(
                    CommandSpec(
                        name="get",
                        description="Get one table's fields and views (table.json)",
                        arguments=(
                            BASE_OPTION,
                            Argument("TABLE", nargs="?"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="record",
                description="Read and write records",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List records as JSONL (records.jsonl)",
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            Argument(
                                "--view",
                                help="View ID or name; its filter "
                                "and sort apply",
                            ),
                            Argument(
                                "--formula",
                                help="Only the records this formula "
                                "is true for (filterByFormula)",
                            ),
                            Argument(
                                "--max-records",
                                type="int",
                                help="Stop after N records",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one record as a JSONL line",
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            RECORD,
                        ),
                    ),
                    CommandSpec(
                        name="create",
                        description="Create records from --fields or stdin",
                        epilog=CREATE_EPILOG,
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            FIELDS_OPTION,
                            TYPECAST_OPTION,
                        ),
                    ),
                    CommandSpec(
                        name="update",
                        description="Update records' cells (PATCH) from "
                        "RECORD --fields or stdin",
                        epilog=UPDATE_EPILOG,
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            FIELDS_OPTION,
                            TYPECAST_OPTION,
                            RECORD,
                        ),
                    ),
                    CommandSpec(
                        name="delete",
                        description="Delete records by RECORD or from stdin",
                        epilog=DELETE_EPILOG,
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            Argument("RECORD", nargs="*"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="comment",
                description="Read and add record comments",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a record's comments, newest first",
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            RECORD,
                        ),
                    ),
                    CommandSpec(
                        name="add",
                        description="Comment on a record",
                        arguments=(
                            BASE_OPTION,
                            TABLE_OPTION,
                            Argument(
                                "--text",
                                help="Comment text (or pipe via stdin)",
                            ),
                            RECORD,
                        ),
                    ),
                ),
            ),
        ),
    ),
    handlers={
        "base list": CLIHandler(fn=reads.base_list),
        "base get": CLIHandler(fn=reads.base_get),
        "table get": CLIHandler(fn=reads.table_get),
        "record list": CLIHandler(fn=reads.record_list),
        "record get": CLIHandler(fn=reads.record_get),
        "record create": CLIHandler(fn=writes.record_create, write=True),
        "record update": CLIHandler(fn=writes.record_update, write=True),
        "record delete": CLIHandler(fn=writes.record_delete, write=True),
        "comment list": CLIHandler(fn=reads.comment_list),
        "comment add": CLIHandler(fn=writes.comment_add, write=True),
    },
    config_model=AirtableConfig,
)

# W&B API integration contract

This suite is a service-level HTTP GraphQL mock. Mirage's Python and TypeScript
mounts query the same server and synthetic fixture. It is not an MCP server,
a Toolathlon capture, or a replacement for the original MCP tool surface.

Run `pnpm run wandb:integ` from `integ/` after installing the Python and TypeScript
workspace dependencies. It starts the mock on a loopback ephemeral port, executes
`cases.json` in both languages, checks the API contract and streaming behavior,
and closes the server. Set `MIRAGE_PYTHON` to choose a Python interpreter.
`pnpm run wandb:server` starts the standalone API on port 5093; `--port` chooses
another port (0 selects an ephemeral port). `--fixture` selects a fixture name and
`--fixture-root` selects a root containing `wandb/<name>.json`. The shared launcher
accepts the same settings as `{"wandb":{"port":0,"fixture":"v1"}}`, including
`fixtureRoot` and an optional announcement `token`; the default is `WANDB_BASE_URL`.
Each instance loads its own fixture at startup. The synthetic fixture key is `0123456789abcdef0123456789abcdef01234567`
(40 characters, accepted by both pinned SDKs).
Mirage's `base_url` and an upstream SDK's `WANDB_BASE_URL` take the printed origin.
The endpoint never forwards an unhandled request to live W&B.

## Wire contract

The VFS queries follow the official SDK's GraphQL operations, inspected at
[wandb v0.21.1](https://github.com/wandb/wandb/tree/v0.21.1/wandb/apis/public):

- `projects.py`: `models(entityName, after, first)` cursor connections.
- `runs.py`: `project.run(name)` uses the run ID; `displayName` is metadata.
  Configuration and summaries are JSON strings; `historyKeys.lastStep` bounds scans.
- `api.py` and `users.py`: the User fields `id`, `name`, `username`, and `email`
  extend the run creator object without an extra account lookup.
- `history.py`: `history(minStep, maxStep, samples)` returns JSON strings;
  a window contains at most `page_size` integer steps and requests that many samples.
  Windows use inclusive `minStep`, exclusive `maxStep`, and continue through gaps.
- `files.py`: `run.files` is a cursor connection; `directUrl`/`url(upload:false)`
  and `sizeBytes` describe original file downloads. `files(names: [...])` resolves
  the exact filename for a download without scanning the catalog again.

## Compatibility audit and gates

`schema.json` records the field/argument types and defaults fetched by public
introspection from `https://api.wandb.ai/graphql`; it contains no account data.
`schema.ts` checks **all 100 fields exposed by the mock**, including return
nullability, connection type names, and accepted arguments, against this capture.
It also validates all ten Mirage queries and requires identical Python/TypeScript
query ASTs. The regular VFS integration command runs this gate. Run
`pnpm run wandb:schema --live` to compare the capture with the current live schema.

All ten Mirage query shapes were also executed successfully against the public
`mluo/deepscaler-1.5b/2h1sn79d` run during this audit, with one-item listing pages
and a two-step history window. These probes verified real response types, including
nullable creator email and JSON-encoded system metrics; they were not a benchmark
capture and did not populate the synthetic fixture.

`pnpm run wandb:conformance` runs **official wandb 0.21.1 and 0.29.0** as isolated
Python child processes against the fake. Both SDKs and their dependency versions
are pinned in `requirements-*.txt`. `python -I` prevents the local integration
helper `requests.py` from shadowing the SDK's HTTP dependency. CI runs this command
after the Mirage integration suite. SDK success accompanied by a GraphQL error
is refused, so a silent legacy fallback cannot conceal a missing mock field.

The SDK checks cover authentication/viewer/default entity, project and run
pagination, default and explicit ordering, numeric filters, run/sweep/creator
metadata, config/summary, complete and selected history, bounded windows, 2048-row
history, file enumeration/metadata/binary downloads, and missing-run failures.
SDK 0.29.0 first calls `parquetHistory`; these synthetic runs have no parquet
exports, so the endpoint reports an empty URL list and their live step metadata.
Actual parquet exports/downloads are not emulated.

One **upstream SDK 0.29.0 bug** is an explicit test expectation: a valid `user: null`
run raises `CommError` because `Run._load_from_attrs` constructs `User(None)`.
The test requires that exact failure instead of inventing a creator or silently
skipping the case. SDK 0.21.1 and both Mirage mounts read the null-creator run.

| Surface                | Audit result / deliberate boundary                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GraphQL schema         | Every exposed field and accepted argument checked against live introspection; other API fields remain unsupported                                                                                            |
| Transport              | Basic authentication, empty/named operation selection, fragments/aliases, and observed 400 validation / 500 execution failures; exact backend error wording is not reproduced                                |
| Identity and dates     | Opaque storage IDs distinct from run IDs; creator ID/name and creation timestamps follow upstream non-null constraints                                                                                       |
| Queries and pagination | Real connection names, forward cursors and counts; pages deliberately capped at two to force pagination; cursor bytes are opaque fixture values                                                              |
| Filters                | Scalar equality/inequality, membership, existence, numeric comparisons, AND/OR; missing/null semantics covered; unsupported fields, operators and literal object/array predicates fail                       |
| History                | `history.maxStep` is exclusive; `sampledHistory.maxStep` is inclusive; selected rows are filtered before the sample budget; order, sparse steps and null values preserved                                    |
| Files                  | Byte sizes, base64 MD5, empty files, Unicode/reserved-character filenames, metadata and exact filename lookup; API URL requires authentication, separate-origin signed URL rejects forwarded API credentials |
| Scalars                | JSONString requires a string; Int64 accepts numeric inputs and rejects unsupported precision beyond JavaScript's safe-integer range                                                                          |
| Accounts               | One synthetic authenticated caller and fixed teams; no emulation of general account permissions, rate limits or token expiry                                                                                 |

A live probe also found the legacy `history` endpoint returning an empty result
for `[0, 1)` even though `[0, 2)` returned steps 0 and 1. The synthetic run-a
fixture reproduces that behavior through `singleStepHistoryEmpty`. Mirage widens
one-step query windows to two steps and filters the result back to the requested
range, preserving the captured last-step boundary and avoiding duplicate rows.

## Request efficiency

`requests.json` exercises 26 command steps in both implementations and asserts
request counts, selected GraphQL fields, exact filename filtering, and cache
invalidation. Project listings fetch run IDs in pages; a cached project listing
also proves that its runs exist, avoiding a separate request when listing each run.
Cold run listings and synthetic-file stats request only the run ID. Metadata
commands fetch neither config/summary content nor history keys, rows, or download URLs.

`run.json` reads the stable run metadata fields from the SDK's `RunFragment`
(identity, tags, sweep/group/job, commit, permission, creation/heartbeat timestamps,
description, notes, creator, system metrics, history keys/count), plus `fileCount`.
Config and summary keep their own files. The mock preserves supplied fixture
metadata; the 19 shared goldens cover populated fields, unavailable fields, distinct
storage/run IDs, zero/false values, Unicode/multiline notes, nested system metrics,
nullable creator email, absent creators, and a raw `wandb-metadata.json` file. The separate conformance suite exercises the official SDKs against the same server.

A file catalog fetch populates metadata for all nested directories in the existing
index. Nested listings and stats reuse it until expiry or invalidation. Reads
select only the requested run fields, and downloads obtain a fresh URL through an
exact filename query. Content and download URLs are not retained in the directory
index. Directory metadata keeps the VFS's normal 600-second index TTL.

The generic read commands stat operands before reading: a cold `cat summary.json`
therefore makes an existence query followed by a summary query; a warm read makes
only the latter. `head -n 1 history.jsonl` still fetches only one history page.

The mock uses graphql-js for schema validation, fragments, aliases, variable names,
selection sets, and introspection. Its project/run/file connections cap pages at
two rows to force pagination. Runs support displayName/name/state and config/summary
filters (`$eq`, `$ne`, `$in`, `$exists`, numeric comparisons, `$and`, `$or`) and sorting.
Selected history preserves only requested keys on rows where all requested keys exist.
Unknown fields, mutations, unsupported filter operators and file patterns fail.

W&B's sampling algorithm is not reproduced: requests requiring downsampling fail
explicitly. Full history and selected windows that fit within the sample count are
supported. Downsampled responses need source captures before benchmark use. The mock
is a defined subset of W&B's API, not full W&B or MCP conformance.

## Fixture and benchmark boundary

`fixtures/wandb/v1.json` is authored synthetic test data. It has no grader-derived
values and no public experiment captures. The long-history and repeated-file entries
are deterministic synthetic generators described by `historyCount` and `repeat`.
No DVC upstream-data stage is warranted for these generated unit/integration inputs.

The local Toolathlon source was inspected at revision
`9be8d8fe07a497b18ee61e3f2ae694e9797f39eb`. Its W&B YAML names the lockon-n fork but
executes unpinned `uvx --from wandb-mcp-server wandb_mcp_server`. The fork exposes
arbitrary GraphQL and SDK project discovery, and additional Weave/report/tools.
Its exact installed MCP package lineage remains to be pinned in vfs-bench;
the SDK conformance pins here do not pin that MCP package. The three original tasks require captures of `mluo/deepscaler-1.5b` and
`mbzuai-llm/Guru`, with the original MCP observation semantics and Notion state for
`experiments-recordings`. Those captures, MCP conformance, grader validation, and
benchmark measurements are subsequent work; this suite does not claim them.

# Vendored backend and framework icons

Mirage's README renders most integration icons from public icon CDNs
(Simple Icons, Iconify, Dashboard Icons). The files in this directory are the
marks that none of those sets carry, vendored so the README does not depend on
a fourth host, and that `docs/images/` does not already carry. Marks the docs
already ship (sandlock, smolvm, ssh, langfuse, mem0, daytona, e2b) are
referenced there rather than copied here.

Each logo is the trademark of its respective owner and is used here only to
identify the integration it names. Their presence indicates that Mirage can
mount or drive that service; it does not imply endorsement or affiliation.

| File            | Source                                                                                                                     | Project                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `seaweedfs.svg` | [`note/icon.svg`](https://github.com/seaweedfs/seaweedfs/blob/master/note/icon.svg)                                        | SeaweedFS (Apache-2.0) |
| `openhands.svg` | [`public/favicon.svg`](https://github.com/All-Hands-AI/OpenHands/blob/main/public/favicon.svg)                             | OpenHands (MIT)        |
| `camel.png`     | [`docs/mintlify/images/CAMEL_Icon.png`](https://github.com/camel-ai/camel/blob/master/docs/mintlify/images/CAMEL_Icon.png) | CAMEL-AI (Apache-2.0)  |
| `lancedb.png`   | [lancedb.com](https://lancedb.com) site favicon                                                                            | LanceDB                |
| `qingstor.png`  | [qingcloud.com](https://www.qingcloud.com/products/qingstor) site favicon                                                  | QingCloud QingStor     |
| `agno.png`      | [github.com/agno-agi](https://github.com/agno-agi) organization avatar                                                     | Agno                   |
| `mastra.png`    | [github.com/mastra-ai](https://github.com/mastra-ai) organization avatar                                                   | Mastra                 |
| `tencent.png`   | [github.com/Tencent](https://github.com/Tencent) organization avatar                                                       | Tencent Cloud          |
| `pyodide.svg`   | [`pyodide-logo-light.svg`](https://github.com/pyodide/pyodide/blob/main/docs/_static/img/pyodide-logo-light.svg)           | Pyodide (MPL-2.0)      |
| `himalaya.png`  | [github.com/pimalaya](https://github.com/pimalaya) organization avatar                                                     | Pimalaya Himalaya      |
| `quickjs.png`   | [github.com/quickjs-ng](https://github.com/quickjs-ng) organization avatar                                                 | QuickJS-ng             |
| `terminal.svg`  | [lucide `terminal`](https://lucide.dev/icons/terminal) on the figure's neutral slate                                       | Lucide (ISC)           |

PNGs are normalized to 128 px on the long edge; the README renders every icon at
20 px high with a width set from the icon's own aspect ratio.

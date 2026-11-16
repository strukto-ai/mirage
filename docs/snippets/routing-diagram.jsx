export const FlowDiagram = ({ kind }) => {
  const setups = {
    routing: {
      policy: false,
      label:
        "Monty, Cloudflare, Mirage itself, an E2B sandbox and an EC2 GPU all share one unified virtual filesystem. Each command typed in the Mirage terminal runs on one of them: a for loop forks four Monty processes, numpy runs on Cloudflare, building features on E2B and training on the EC2 GPU.",
      steps: [
        { line: "for f in raw/*.csv; do python3 count.py $f & done", target: 0, forks: true },
        { line: 'python3 -c "import numpy as np; …"', target: 1 },
        { line: "python3 build.py", target: 3 },
        { line: "python3 train.py", target: 4 },
      ],
    },
    secured: {
      policy: true,
      label:
        "Every command typed in the Mirage terminal is checked first. An allowed Python script runs on Monty over the unified virtual filesystem, posting to Slack is denied, a file shown again inside a hidden folder is read by Mirage from the filesystem, and a hidden secret does not exist for the agent.",
      steps: [
        { line: "python3 count.py reports/q3.csv", target: 0 },
        { line: "slack send-message --text hi", outcome: "deny" },
        { line: "cat secrets/README.md", target: 2, outcome: "show" },
        { line: "cat secrets/aws.txt", outcome: "hide" },
      ],
    },
  }
  const { steps, policy, label } = setups[kind] || setups.routing
  const machines = [
    ["Monty", "/images/pydantic-logo.svg"],
    ["Cloudflare", "/images/cloudflare-logo.svg"],
    ["Mirage", "/logo/light.svg", "/logo/dark.svg"],
    ["E2B", "/images/e2b-logo.svg"],
    ["EC2 GPU", "/images/ec2-logo.svg"],
  ]
  const forks = 4
  const services = [
    ["S3", "/images/s3-logo.svg"],
    ["Gmail", "/images/gmail-logo.svg"],
    ["GitHub", "/images/github-logo.svg"],
    ["Notion", "/images/notion-logo.svg"],
    ["Slack", "/images/slack-logo.svg"],
    ["Google Drive", "/images/gdrive-logo.svg"],
    ["Linear", "/images/linear-logo.svg"],
    ["Dropbox", "/images/dropbox-logo.svg"],
    ["Postgres", "/images/postgres-logo.svg"],
    ["Redis", "/images/redis-logo.svg"],
    ["Google Cloud Storage", "/images/gcs-logo.svg"],
    ["Cloudflare R2", "/images/cloudflare-logo.svg"],
    ["MongoDB", "/images/mongodb-logo.svg"],
    ["Hugging Face", "/images/huggingface-logo.svg"],
    ["Discord", "/images/discord-logo.svg"],
    ["Google Docs", "/images/gdocs-logo.svg"],
    ["Google Sheets", "/images/gsheets-logo.svg"],
    ["Google Slides", "/images/gslides-logo.svg"],
    ["Google Calendar", "/images/gcal-logo.svg"],
    ["Box", "/images/box-logo.svg"],
    ["Airtable", "/images/airtable-logo.svg"],
    ["Trello", "/images/trello-logo.svg"],
    ["Supabase", "/images/supabase-logo.svg"],
    ["Databricks", "/images/databricks-logo.svg"],
    ["Qdrant", "/images/qdrant-logo.svg"],
    ["Chroma", "/images/chroma-logo.svg"],
    ["Weights & Biases", "/images/wandb-logo.svg"],
    ["Langfuse", "/images/langfuse-logo.svg"],
    ["Jaeger", "/images/jaeger-logo.svg"],
    ["Dify", "/images/dify-logo.svg"],
    ["MinIO", "/images/minio-logo.svg"],
    ["Backblaze", "/images/backblaze-logo.svg"],
    ["Wasabi", "/images/wasabi-logo.svg"],
    ["DigitalOcean", "/images/digitalocean-logo.svg"],
    ["Scaleway", "/images/scaleway-logo.svg"],
    ["Aliyun", "/images/aliyun-logo.svg"],
    ["Tencent Cloud", "/images/tencent-logo.svg"],
    ["Oracle Cloud", "/images/oracle-logo.svg"],
    ["Ceph", "/images/ceph-logo.svg"],
    ["SeaweedFS", "/images/seaweedfs-logo.svg"],
    ["Nextcloud", "/images/nextcloud-logo.svg"],
    ["TiDB", "/images/tidb-logo.svg"],
    ["SSH", "/images/ssh-logo.svg"],
    ["Mem0", "/images/mem0.svg"],
  ]
  const timeline = []
  let clock = 300
  steps.forEach((step) => {
    const size = step.line.length
    const typed = clock + Math.min(650, size * 13)
    timeline.push({ start: clock, typed, draw: typed + 120, size })
    clock = typed + 120 + (step.forks ? 2200 : 1600)
  })
  const total = clock
  const widest = Math.max(...steps.map((step) => step.line.length))

  const [root, setRoot] = useState(null)
  const [width, setWidth] = useState(0)
  const [layout, setLayout] = useState(null)
  const [visible, setVisible] = useState(false)
  const [still, setStill] = useState(false)
  const [now, setNow] = useState(0)
  const wide = width >= 520

  useEffect(() => {
    if (root === null || typeof ResizeObserver === "undefined") return undefined
    const measure = () => {
      const base = root.getBoundingClientRect()
      const place = (element) => {
        const box = element.getBoundingClientRect()
        return { left: box.left - base.left, top: box.top - base.top, right: box.right - base.left, bottom: box.bottom - base.top }
      }
      setWidth(base.width)
      setLayout({
        w: base.width,
        h: base.height,
        vfs: place(root.querySelector("[data-vfs]")),
        card: place(root.querySelector("[data-card]")),
        gate: policy ? place(root.querySelector("[data-gate]")) : null,
        machines: [...root.querySelectorAll("[data-machine]")].map(place),
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    measure()
    return () => observer.disconnect()
  }, [root, wide])
  useEffect(() => {
    if (root === null || typeof IntersectionObserver === "undefined") return undefined
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStill(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(root)
    return () => observer.disconnect()
  }, [root])
  useEffect(() => {
    if (!visible || still) return undefined
    const started = performance.now() - now
    const timer = setInterval(() => setNow(performance.now() - started), 33)
    return () => clearInterval(timer)
  }, [visible, still])

  const elapsed = still ? timeline[0].draw + 2000 : now % total
  const current = timeline.reduce((last, step, index) => (elapsed >= step.start ? index : last), 0)
  const step = timeline[current]
  const active = steps[current]
  const outcome = active.outcome || "allow"
  const typedChars = Math.max(0, Math.min(step.size, Math.floor(((elapsed - step.start) / (step.typed - step.start)) * step.size)))
  const started = elapsed >= step.draw
  const target = active.target === undefined ? -1 : active.target
  const parts = (policy ? 1 : 0) + (target >= 0 ? 2 : 0)
  const segment = 280
  const reach = started ? Math.max(0, Math.min(parts, (elapsed - step.draw) / segment)) : 0
  const atMachine = policy ? 2 : 1
  const gated = policy && reach >= 1
  const lit = target >= 0 && reach >= atMachine ? target : -1
  const reached = target >= 0 && reach >= parts
  const arrived = step.draw + atMachine * segment
  const spawned = active.forks && lit >= 0 ? Math.max(0, Math.min(forks, Math.floor((elapsed - arrived - 100) / 180) + 1)) : 0
  const tone = { allow: "var(--rd-on)", show: "var(--rd-on)", deny: "var(--rd-deny)", hide: "var(--rd-ink)" }[outcome]
  const keywords = ["for", "in", "do", "done"]
  const tokens = (text) => {
    const out = []
    let command = true
    for (const part of text.match(/"[^"]*"?|\$\w+|\s+|[;&|]|[^\s;&|"]+/g) || []) {
      let kind = "plain"
      if (/^\s+$/.test(part)) kind = "plain"
      else if (part.startsWith('"')) kind = "string"
      else if (part.startsWith("$")) kind = "variable"
      else if (/^[;&|]$/.test(part)) {
        kind = "operator"
        command = true
      } else if (keywords.includes(part)) {
        kind = "keyword"
        command = part === "do"
      } else if (part.startsWith("-")) kind = "flag"
      else if (command) {
        kind = "command"
        command = false
      }
      out.push([part, kind])
    }
    return out
  }

  const middle = (box) => (box.left + box.right) / 2
  const up = (machine) => `M ${middle(machine)} ${machine.top} L ${middle(machine)} ${layout.vfs.bottom}`
  const route = (machine) => {
    const from = policy ? layout.gate : layout.card
    const x0 = middle(from)
    const y0 = from.top
    const x1 = middle(machine)
    const y1 = machine.bottom
    const k = (y0 - y1) / 2
    return `M ${x0} ${y0} C ${x0} ${y0 - k}, ${x1} ${y1 + k}, ${x1} ${y1}`
  }
  const stem = () => `M ${middle(layout.card)} ${layout.card.top} L ${middle(layout.card)} ${layout.gate.bottom}`
  const segments = () => {
    if (!started) return []
    const out = policy ? [stem()] : []
    if (target >= 0 && layout.machines[target]) out.push(route(layout.machines[target]), up(layout.machines[target]))
    return out
  }
  const folder = (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
  const mini = wide ? 16 : 12
  const machine = ([label, logo, dark], position) => {
    const on = lit === position
    return (
      <div
        key={label}
        data-machine
        className={`rd-box rd-machine ${on ? "rd-on" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: wide ? 62 : 74,
          padding: wide ? "8px 6px" : "7px 4px",
          opacity: on ? 1 : 0.55,
        }}
      >
        <div style={{ display: "flex", flexDirection: wide ? "row" : "column", alignItems: "center", gap: wide ? 9 : 5 }}>
          {dark ? (
            <>
              <img src={logo} alt={label} className="rd-light-only" style={{ height: wide ? 20 : 13, width: "auto" }} />
              <img src={dark} alt={label} className="rd-dark-only" style={{ height: wide ? 20 : 13, width: "auto" }} />
            </>
          ) : (
            <>
              <img src={logo} alt="" width={wide ? 20 : 18} height={wide ? 20 : 18} style={{ flex: "none" }} />
              <span style={{ textAlign: wide ? "left" : "center", lineHeight: 1.35 }}>{label}</span>
            </>
          )}
        </div>
        {position === 0 && steps.some((one) => one.forks) && (
          <div
            className="rd-forks"
            style={{
              display: "flex",
              justifyContent: "center",
              gap: wide ? 4 : 3,
              height: spawned > 0 ? mini : 0,
              marginTop: spawned > 0 ? (wide ? 6 : 5) : 0,
            }}
          >
            {Array.from({ length: forks }, (_, fork) => (
              <span
                key={fork}
                className="rd-fork"
                style={{ width: mini, height: mini, opacity: fork < spawned ? 1 : 0, transform: fork < spawned ? "none" : "scale(0.6)" }}
              >
                <img src={logo} alt="" width={mini - 6} height={mini - 6} />
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="routing-diagram not-prose my-6 rounded-2xl" style={{ padding: wide ? "36px 28px" : "28px 14px" }}>
      <style>{`
        .routing-diagram {
          --rd-paper: #f0ece2; --rd-surface: #faf8f2; --rd-edge: #cec6b3;
          --rd-ink: #0a0a0a; --rd-muted: #5b5647; --rd-accent: #047857; --rd-on: #b08a2e; --rd-deny: #b91c1c;
          background: var(--rd-paper); color: var(--rd-ink);
        }
        html.dark .routing-diagram {
          --rd-paper: #0e0e10; --rd-surface: #1a1a1d; --rd-edge: #3f3f46;
          --rd-ink: #ffffff; --rd-muted: #a1a1aa; --rd-accent: #34d399; --rd-on: #c9a03e; --rd-deny: #f87171;
        }
        .routing-diagram .rd-box { background: var(--rd-surface); border: 1px solid var(--rd-edge); }
        .routing-diagram .rd-machine { transition: opacity .3s, border-color .3s; }
        .routing-diagram .rd-machine.rd-on, .routing-diagram .rd-vfs.rd-on { border-color: var(--rd-on); }
        .routing-diagram .rd-vfs, .routing-diagram .rd-gate { transition: border-color .3s; }
        .routing-diagram .rd-chip { border: 1px solid var(--rd-edge); padding: 1px 8px; color: var(--rd-muted); transition: color .3s, border-color .3s; }
        .routing-diagram .rd-chip.rd-allow, .routing-diagram .rd-chip.rd-show { border-color: var(--rd-on); color: var(--rd-on); }
        .routing-diagram .rd-chip.rd-deny { border-color: var(--rd-deny); color: var(--rd-deny); }
        .routing-diagram .rd-chip.rd-hide { border-color: var(--rd-ink); color: var(--rd-ink); }
        .routing-diagram .rd-forks { transition: height .3s, margin-top .3s; }
        .routing-diagram .rd-fork { display: inline-flex; align-items: center; justify-content: center; background: var(--rd-surface); border: 1px solid var(--rd-edge); transition: opacity .25s, transform .25s; }
        .routing-diagram img { margin: 0; display: block; }
        .routing-diagram .rd-keyword, .routing-diagram .rd-operator { color: #cf222e; }
        .routing-diagram .rd-command { color: #953800; }
        .routing-diagram .rd-flag { color: #0550ae; }
        .routing-diagram .rd-string { color: #0a3069; }
        .routing-diagram .rd-variable { color: #8250df; }
        html.dark .routing-diagram .rd-keyword, html.dark .routing-diagram .rd-operator { color: #ff7b72; }
        html.dark .routing-diagram .rd-command { color: #ffa657; }
        html.dark .routing-diagram .rd-flag { color: #79c0ff; }
        html.dark .routing-diagram .rd-string { color: #a5d6ff; }
        html.dark .routing-diagram .rd-variable { color: #d2a8ff; }
        html.dark .routing-diagram .rd-invert { filter: invert(1); }
        .routing-diagram .rd-marquee { width: 100%; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
        .routing-diagram .rd-track { display: flex; width: max-content; animation: rd-marquee 70s linear infinite; }
        @keyframes rd-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .routing-diagram .rd-track { animation: none; } }
        .routing-diagram .rd-dark-only { display: none; }
        html.dark .routing-diagram .rd-dark-only { display: block; }
        html.dark .routing-diagram .rd-light-only { display: none; }
      `}</style>
      <div
        ref={setRoot}
        role="img"
        aria-label={label}
        style={{ position: "relative", display: "flex", flexDirection: "column", fontSize: wide ? 13 : 11 }}
      >
        {layout && (
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          >
            {layout.machines.map((place, position) => (
              <g key={position} fill="none" strokeWidth="1">
                <path d={up(place)} stroke="var(--rd-edge)" />
                <path d={route(place)} stroke="var(--rd-edge)" />
              </g>
            ))}
            {policy && <path d={stem()} fill="none" stroke="var(--rd-edge)" strokeWidth="1" />}
            <g fill="none" stroke={tone} strokeWidth="1">
              {segments().map((d, index) => (
                <path
                  key={`${current}-${index}`}
                  d={d}
                  pathLength="1"
                  strokeDasharray="1"
                  strokeDashoffset={1 - Math.max(0, Math.min(1, reach - index))}
                />
              ))}
            </g>
          </svg>
        )}
        <div
          data-vfs
          className={`rd-box rd-vfs ${reached ? "rd-on" : ""}`}
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: wide ? 12 : 10,
            padding: wide ? "16px 14px" : "12px 10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: wide ? 15 : 12.5, fontWeight: 500 }}>
            {folder}
            <span>Unified Virtual Filesystem</span>
          </div>
          <div className="rd-marquee">
            <div className="rd-track">
              {[...services, ...services].map(([name, logo], index) => (
                <img
                  key={index}
                  src={logo}
                  alt={index < services.length ? name : ""}
                  title={name}
                  width={wide ? 20 : 16}
                  height={wide ? 20 : 16}
                  className={name === "GitHub" ? "rd-invert" : undefined}
                  style={{ marginRight: wide ? 14 : 11, flex: "none" }}
                />
              ))}
            </div>
          </div>
        </div>
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: `repeat(${machines.length}, minmax(0, 1fr))`,
            alignItems: "stretch",
            gap: wide ? 14 : 6,
            marginTop: 40,
            fontSize: wide ? 12.5 : 10,
          }}
        >
          {machines.map(machine)}
        </div>
        {policy && (
          <div
            data-gate
            className="rd-box rd-gate"
            style={{
              position: "relative",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "center",
              gap: wide ? 14 : 10,
              marginTop: 40,
              padding: wide ? "10px 14px" : "9px 10px",
              borderColor: gated ? tone : undefined,
            }}
          >
            <span className="font-mono" style={{ display: "flex", gap: 6, fontSize: wide ? 12 : 10.5 }}>
              {["allow", "deny", "show", "hide"].map((chip) => (
                <span key={chip} className={`rd-chip ${gated && chip === outcome ? `rd-${chip}` : ""}`}>
                  {chip}
                </span>
              ))}
            </span>
          </div>
        )}
        <div data-card className="rd-box" style={{ position: "relative", marginTop: 40 }}>
          <div
            style={{
              display: "flex",
              flexDirection: wide ? "row" : "column",
              alignItems: "center",
              justifyContent: "center",
              gap: wide ? 32 : 14,
              padding: wide ? "12px 20px" : "12px 12px",
            }}
          >
            <div style={{ flex: "none" }}>
              <img src="/logo/light.svg" alt="mirage" className="rd-light-only" style={{ height: wide ? 28 : 22, width: "auto" }} />
              <img src="/logo/dark.svg" alt="mirage" className="rd-dark-only" style={{ height: wide ? 28 : 22, width: "auto" }} />
            </div>
            <div className="rd-box font-mono" style={{ maxWidth: "100%", padding: wide ? "7px 16px" : "7px 10px" }}>
              <div
                style={{
                  width: `${widest + 2}ch`,
                  maxWidth: "100%",
                  textAlign: "center",
                  whiteSpace: wide ? "pre" : "pre-wrap",
                  lineHeight: 1.7,
                }}
              >
                <span style={{ color: "var(--rd-accent)" }}>$ </span>
                {(() => {
                  let left = typedChars
                  return tokens(active.line).map(([part, kind], index) => {
                    const seen = part.slice(0, Math.max(0, left))
                    left -= part.length
                    return (
                      <span key={`${current}-${index}`} className={`rd-${kind}`}>
                        {seen}
                        <span style={{ visibility: "hidden" }}>{part.slice(seen.length)}</span>
                      </span>
                    )
                  })
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

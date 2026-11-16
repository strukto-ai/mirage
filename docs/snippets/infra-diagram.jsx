export const InfraDiagram = () => {
  const labels = ["Sessions", "Jobs", "Command Logs"]
  const ram = (size) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M12 11V9M2 15h20" />
      <path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z" />
    </svg>
  )
  const disk = (size) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <path d="M22 12H2M6 16h.01M10 16h.01" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  )
  const machines = [
    ["Monty", "/images/pydantic-logo.svg"],
    ["Cloudflare", "/images/cloudflare-logo.svg"],
    ["E2B", "/images/e2b-logo.svg"],
    ["EC2 GPU", "/images/ec2-logo.svg"],
  ]
  const redis = ["Redis", "/images/redis-logo.svg"]
  const views = [
    {
      command: "cd /notes && export TICKET=4821",
      backends: [redis, redis, ["Langfuse", "/images/langfuse-logo.svg"]],
    },
    {
      command: "sort -u ids.txt > refunds.txt &",
      backends: [
        ["Disk", disk],
        ["RAM", ram],
        ["Disk", disk],
      ],
    },
    {
      command: "cat refunds.txt",
      backends: [["S3", "/images/s3-logo.svg"], redis, ["Jaeger", "/images/jaeger-logo.svg"]],
    },
  ]
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
    ["SQLite", "/images/sqlite-logo.svg"],
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
  ]
  const timeline = []
  let clock = 300
  views.forEach((view) => {
    const size = view.command.length
    const typed = clock + Math.min(650, size * 13)
    const draw = typed + 120
    timeline.push({ start: clock, typed, draw, size })
    clock = draw + 2000
  })
  const total = clock
  const widest = Math.max(...views.map((view) => view.command.length))

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
        machines: [...root.querySelectorAll("[data-machine]")].map(place),
        slots: [...root.querySelectorAll("[data-slot]")].map(place),
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

  const elapsed = still ? timeline[0].draw + 600 : now % total
  const current = timeline.reduce((last, step, index) => (elapsed >= step.start ? index : last), 0)
  const step = timeline[current]
  const typedChars = Math.max(0, Math.min(step.size, Math.floor(((elapsed - step.start) / (step.typed - step.start)) * step.size)))
  const drawn = elapsed >= step.draw ? Math.min(1, (elapsed - step.draw) / 450) : 0
  const on = drawn >= 0.625

  const keywords = ["for", "in", "do", "done"]
  const tokens = (text) => {
    const out = []
    let command = true
    for (const part of text.match(/"[^"]*"?|\$\w+|\s+|[;&|<>]|[^\s;&|<>"]+/g) || []) {
      let kind = "plain"
      if (/^\s+$/.test(part)) kind = "plain"
      else if (part.startsWith('"')) kind = "string"
      else if (part.startsWith("$")) kind = "variable"
      else if (/^[;&|<>]$/.test(part)) {
        kind = "operator"
        command = part !== ">" && part !== "<"
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
  const up = (machine) => `M ${middle(machine)} ${layout.vfs.bottom} L ${middle(machine)} ${machine.top}`
  const rise = (machine) => {
    const x0 = middle(layout.card)
    const y0 = layout.card.top
    const x1 = middle(machine)
    const y1 = machine.bottom
    const k = (y0 - y1) / 2
    return `M ${x0} ${y0} C ${x0} ${y0 - k}, ${x1} ${y1 + k}, ${x1} ${y1}`
  }
  const route = (slot) => {
    const x0 = middle(layout.card)
    const y0 = layout.card.bottom
    const x1 = middle(slot)
    const y1 = slot.top
    const k = (y1 - y0) / 2
    return `M ${x0} ${y0} C ${x0} ${y0 + k}, ${x1} ${y1 - k}, ${x1} ${y1}`
  }
  const icon = (mark, size) =>
    typeof mark === "string" ? <img src={mark} alt="" width={size} height={size} style={{ flex: "none" }} /> : mark(size)
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
  const slot = (label, position) => {
    const [name, mark] = views[current].backends[position]
    return (
      <div
        key={label}
        data-slot
        className={`ia-box ia-slot ${on ? "ia-on" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: wide ? "9px 10px" : "8px 4px",
          opacity: on ? 1 : 0.6,
        }}
      >
        <div className="ia-muted" style={{ fontSize: wide ? 11 : 9, lineHeight: 1.3, textAlign: "center", marginBottom: wide ? 7 : 5 }}>
          {label}
        </div>
        <div
          key={current}
          className={still ? undefined : "ia-swap"}
          style={{ display: "flex", flexDirection: wide ? "row" : "column", alignItems: "center", gap: wide ? 8 : 4 }}
        >
          {icon(mark, wide ? 20 : 18)}
          <span style={{ fontWeight: 500 }}>{name}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="infra-diagram not-prose my-6 rounded-2xl" style={{ padding: wide ? "36px 28px" : "28px 14px" }}>
      <style>{`
        .infra-diagram {
          --ia-paper: #f0ece2; --ia-surface: #faf8f2; --ia-edge: #cec6b3;
          --ia-ink: #0a0a0a; --ia-muted: #5b5647; --ia-accent: #047857; --ia-on: #b08a2e;
          background: var(--ia-paper); color: var(--ia-ink);
        }
        html.dark .infra-diagram {
          --ia-paper: #0e0e10; --ia-surface: #1a1a1d; --ia-edge: #3f3f46;
          --ia-ink: #ffffff; --ia-muted: #a1a1aa; --ia-accent: #34d399; --ia-on: #c9a03e;
        }
        .infra-diagram .ia-box { background: var(--ia-surface); border: 1px solid var(--ia-edge); }
        .infra-diagram .ia-muted { color: var(--ia-muted); }
        .infra-diagram .ia-slot { transition: opacity .3s, border-color .3s; }
        .infra-diagram .ia-slot.ia-on { border-color: var(--ia-on); }
        .infra-diagram .ia-swap { animation: ia-swap .45s ease-out; }
        @keyframes ia-swap { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        .infra-diagram img { margin: 0; display: block; }
        .infra-diagram .ia-keyword, .infra-diagram .ia-operator { color: #cf222e; }
        .infra-diagram .ia-command { color: #953800; }
        .infra-diagram .ia-flag { color: #0550ae; }
        .infra-diagram .ia-string { color: #0a3069; }
        .infra-diagram .ia-variable { color: #8250df; }
        html.dark .infra-diagram .ia-keyword, html.dark .infra-diagram .ia-operator { color: #ff7b72; }
        html.dark .infra-diagram .ia-command { color: #ffa657; }
        html.dark .infra-diagram .ia-flag { color: #79c0ff; }
        html.dark .infra-diagram .ia-string { color: #a5d6ff; }
        html.dark .infra-diagram .ia-variable { color: #d2a8ff; }
        html.dark .infra-diagram .ia-invert { filter: invert(1); }
        .infra-diagram .ia-marquee { width: 100%; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
        .infra-diagram .ia-track { display: flex; width: max-content; animation: ia-marquee 70s linear infinite; }
        @keyframes ia-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .infra-diagram .ia-track, .infra-diagram .ia-swap { animation: none; } }
        .infra-diagram .ia-dark-only { display: none; }
        html.dark .infra-diagram .ia-dark-only { display: block; }
        html.dark .infra-diagram .ia-light-only { display: none; }
      `}</style>
      <div
        ref={setRoot}
        role="img"
        aria-label="Monty, a Cloudflare sandbox, an E2B sandbox and an EC2 GPU share one unified virtual filesystem, and the Mirage terminal runs commands on them. Under Mirage, it keeps its sessions, jobs and command logs on backends that can be swapped. It cycles through three setups: Redis, Redis and Langfuse; disk, memory and disk; then S3, Redis and Jaeger. The commands run the same on each."
        style={{ position: "relative", display: "flex", flexDirection: "column", fontSize: wide ? 13 : 11 }}
      >
        {layout && (
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          >
            {layout.machines.map((place, position) => (
              <g key={position} fill="none" stroke="var(--ia-edge)" strokeWidth="1">
                <path d={up(place)} />
                <path d={rise(place)} />
              </g>
            ))}
            {layout.slots.map((place, position) => (
              <path key={position} d={route(place)} fill="none" stroke="var(--ia-edge)" strokeWidth="1" />
            ))}
            {drawn > 0 &&
              layout.slots.map((place, position) => (
                <path
                  key={position}
                  d={route(place)}
                  fill="none"
                  stroke="var(--ia-on)"
                  strokeWidth="1"
                  pathLength="1"
                  strokeDasharray="1"
                  strokeDashoffset={1 - drawn}
                />
              ))}
          </svg>
        )}
        <div
          data-vfs
          className="ia-box"
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
          <div className="ia-marquee">
            <div className="ia-track">
              {[...services, ...services].map(([name, logo], index) => (
                <img
                  key={index}
                  src={logo}
                  alt={index < services.length ? name : ""}
                  title={name}
                  width={wide ? 20 : 16}
                  height={wide ? 20 : 16}
                  className={name === "GitHub" ? "ia-invert" : undefined}
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
            gridTemplateColumns: wide ? `repeat(${machines.length}, 132px)` : `repeat(${machines.length}, minmax(0, 1fr))`,
            justifyContent: "space-between",
            alignItems: "stretch",
            gap: wide ? 14 : 6,
            marginTop: 30,
            fontSize: wide ? 12.5 : 10,
          }}
        >
          {machines.map(([label, logo]) => (
            <div
              key={label}
              data-machine
              className="ia-box"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: wide ? "row" : "column",
                gap: wide ? 9 : 5,
                minHeight: wide ? 52 : 62,
                padding: wide ? "8px 10px" : "7px 4px",
              }}
            >
              <img src={logo} alt="" width={wide ? 20 : 18} height={wide ? 20 : 18} style={{ flex: "none" }} />
              <span style={{ textAlign: wide ? "left" : "center", lineHeight: 1.35 }}>{label}</span>
            </div>
          ))}
        </div>
        <div data-card className="ia-box" style={{ position: "relative", marginTop: wide ? 56 : 44 }}>
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
              <img src="/logo/light.svg" alt="mirage" className="ia-light-only" style={{ height: wide ? 28 : 22, width: "auto" }} />
              <img src="/logo/dark.svg" alt="mirage" className="ia-dark-only" style={{ height: wide ? 28 : 22, width: "auto" }} />
            </div>
            <div className="ia-box font-mono" style={{ maxWidth: "100%", padding: wide ? "7px 16px" : "7px 10px" }}>
              <div
                style={{
                  width: `${widest + 2}ch`,
                  maxWidth: "100%",
                  textAlign: "center",
                  whiteSpace: "pre",
                  lineHeight: 1.7,
                }}
              >
                <span style={{ color: "var(--ia-accent)" }}>$ </span>
                {(() => {
                  let left = typedChars
                  return tokens(views[current].command).map(([part, kind], index) => {
                    const seen = part.slice(0, Math.max(0, left))
                    left -= part.length
                    return (
                      <span key={`${current}-${index}`} className={`ia-${kind}`}>
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
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))`,
            alignItems: "stretch",
            gap: wide ? 14 : 6,
            marginTop: wide ? 56 : 44,
            fontSize: wide ? 12.5 : 10,
          }}
        >
          {labels.map(slot)}
        </div>
      </div>
    </div>
  )
}

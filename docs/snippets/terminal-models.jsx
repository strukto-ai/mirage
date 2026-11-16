export const SandboxesVsTerminals = () => {
  const button = (label, onClick, pressed) => (
    <button
      key={label}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="tm-btn rounded-lg border px-2.5 py-1 text-xs transition-colors"
    >
      {label}
    </button>
  )
  const stepper = (id, label, value, setValue, last, text) => (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-14 font-semibold">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min="0"
        max={last}
        step="1"
        value={value}
        onChange={(event) => setValue(Number(event.target.value))}
        aria-valuetext={text}
        className="w-40"
        style={{ accentColor: "var(--tm-b)" }}
      />
      <span className="w-14 tabular-nums">{text}</span>
      <button
        type="button"
        aria-label={`Fewer ${label.toLowerCase()}`}
        disabled={value === 0}
        onClick={() => setValue(value - 1)}
        className="tm-btn h-7 w-7 rounded-lg border text-sm disabled:opacity-40"
      >
        −
      </button>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value === last}
        onClick={() => setValue(value + 1)}
        className="tm-btn h-7 w-7 rounded-lg border text-sm disabled:opacity-40"
      >
        +
      </button>
    </div>
  )
  const steps = [1, 5, 10, 25, 50, 100]
  const shares = [
    ["None", 0],
    ["1 in 10", 0.1],
    ["1 in 4", 0.25],
    ["Half", 0.5],
    ["All", 1],
  ]
  const sizes = [32, 64, 128]
  const [step, setStep] = useState(4)
  const [share, setShare] = useState(1)
  const [size, setSize] = useState(0)
  const agents = steps[step]
  const busy = Math.round(agents * shares[share][1])
  const idle = agents - busy
  const holds = sizes[size]

  const base = 100
  const idleMB = idle * 0.01
  const busyMB = busy * holds
  const used = base + idleMB + busyMB
  const containers = [
    ["lite", 256, 2],
    ["basic", 1024, 4],
    ["standard-1", 4096, 8],
    ["standard-2", 6144, 12],
    ["standard-3", 8192, 16],
    ["standard-4", 12288, 20],
  ]
  const fit = containers.find(([, mb]) => mb >= used)
  const [kind, capacity, disk] = fit || containers[containers.length - 1]
  const servers = fit ? 1 : Math.ceil((idleMB + busyMB) / (capacity - base))
  const total = servers * capacity

  const width = 300
  const height = 184
  const cols = [1, 5, 5, 9, 10, 20][step]
  const gap = agents >= 50 ? 3 : 5
  const cell = Math.min(44, (width - (cols - 1) * gap) / cols)
  const rows = Math.ceil(agents / cols)
  const left = (width - (cols * cell + (cols - 1) * gap)) / 2
  const top = 3 + (height - (rows * cell + (rows - 1) * gap)) / 2
  const corner = Math.min(3, cell / 5)

  const zoom = { x: 380, y: 30, w: 296, h: 130 }
  const pitch = agents <= 25 ? 16 : 11
  const radius = agents <= 25 ? 5 : 3.5
  const dotCols = Math.min(agents, Math.floor((zoom.w - 20) / pitch))
  const dotRows = Math.ceil(agents / dotCols)
  const dotsLeft = zoom.x + (zoom.w - (dotCols - 1) * pitch) / 2
  const dotsTop = zoom.y + 12 + (64 - (dotRows - 1) * pitch) / 2

  const bar = { x: zoom.x + 12, y: zoom.y + 92, w: zoom.w - 24, h: 14 }
  const scale = bar.w / total
  const baseW = servers * base * scale
  const idleW = Math.max(idle ? 1 : 0, idleMB * scale)
  const busyW = busyMB * scale

  const megabytes = agents * 256
  const price = (gib, gb) => (gib * 0.0000025 + gb * 0.00000007) * 30 * 24 * 3600
  const sandboxCost = agents * price(0.25, 2)
  const terminalCost = servers * price(capacity / 1024, disk)
  const saving = sandboxCost - terminalCost
  const money = (value) => {
    const amount = Math.abs(value)
    const text = amount >= 100 ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(amount >= 1 ? 2 : 3)
    return `${value < 0 ? "-" : ""}$${text}`
  }
  const format = (mb) =>
    mb >= 1024 ? `${Number((mb / 1024).toFixed(1))} GB` : mb > 0 && mb < 1 ? "under 1 MB" : `${Math.round(mb)} MB`
  const reserved = format(megabytes)
  const count = agents.toLocaleString("en-US")
  const marks = Array.from({ length: agents })
  const host =
    servers === 1 ? `Mirage on one Cloudflare ${kind} container` : `Mirage on ${servers} Cloudflare ${kind} containers`
  const fleet = `${count} Cloudflare lite container${agents === 1 ? "" : "s"}`
  const tip = (text) => (
    <span className="tm-tip" tabIndex={0} aria-label={text}>
      ?<span className="tm-pop" role="tooltip">{text}</span>
    </span>
  )
  const stat = (label, value, detail) => (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--tm-edge)" }}>
      <div className="tm-muted text-xs">{label}</div>
      <div className="tm-ink mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="tm-muted text-xs">{detail}</div>}
    </div>
  )

  return (
    <div className="terminal-model not-prose my-6 rounded-2xl border p-4">
      <style>{`
        .terminal-model {
          --tm-surface: #faf8f2; --tm-edge: #cec6b3; --tm-edge-soft: #e2dccd;
          --tm-ink: #0a0a0a; --tm-muted: #5b5647; --tm-reserved: #cbc5b7; --tm-base: #a39a86;
          --tm-a: #455a64; --tm-b: #b08a2e; --tm-refused: #b91c1c;
          background: var(--tm-surface); border-color: var(--tm-edge); color: var(--tm-ink);
        }
        html.dark .terminal-model {
          --tm-surface: #1a1a1d; --tm-edge: #3f3f46; --tm-edge-soft: #2a2a2f;
          --tm-ink: #ffffff; --tm-muted: #a1a1aa; --tm-reserved: #3a3a40; --tm-base: #71717a;
          --tm-a: #8aa4b1; --tm-b: #c9a03e; --tm-refused: #fca5a5;
        }
        .terminal-model .tm-ink { color: var(--tm-ink); }
        .terminal-model .tm-muted { color: var(--tm-muted); }
        .terminal-model .tm-btn { border-color: var(--tm-edge); color: var(--tm-muted); }
        .terminal-model .tm-btn:hover { border-color: var(--tm-muted); }
        .terminal-model .tm-btn[aria-pressed="true"] { background: var(--tm-ink); border-color: var(--tm-ink); color: var(--tm-surface); }
        .terminal-model .tm-dark-only { display: none; }
        html.dark .terminal-model .tm-dark-only { display: inline; }
        html.dark .terminal-model .tm-light-only { display: none; }
        .terminal-model .tm-tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 1px solid var(--tm-edge); border-radius: 9999px; font-size: 10px; cursor: help; }
        .terminal-model .tm-pop { display: none; position: absolute; top: 22px; right: -8px; width: 260px; padding: 8px 10px; border: 1px solid var(--tm-edge); border-radius: 8px; background: var(--tm-surface); color: var(--tm-ink); font-size: 12px; line-height: 1.45; z-index: 10; }
        .terminal-model .tm-tip:hover .tm-pop, .terminal-model .tm-tip:focus .tm-pop { display: block; }
      `}</style>
      <div className="flex flex-col gap-2 text-sm tm-ink">
        {stepper("agent-count", "Agents", step, setStep, steps.length - 1, count)}
        {stepper("active-share", "Active", share, setShare, shares.length - 1, shares[share][0])}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="What each active terminal holds">
          <span className="mr-1 font-semibold">Each holds</span>
          {sizes.map((mb, index) => button(`${mb} MB`, () => setSize(index), size === index))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {stat("Sandbox Cost / Month", money(sandboxCost))}
        {stat("In-Process Terminals Cost / Month", money(terminalCost))}
        {stat("Saving / Month", money(saving))}
      </div>

      <div className="mt-4 flex text-xs tm-muted">
        <div className="flex items-center gap-1.5" style={{ width: "55.9%" }}>
          <img src="/images/cloudflare-logo.svg" alt="" className="h-4 w-4" />
          <span>{fleet}</span>
          {tip(
            "Each sandbox is Cloudflare's smallest container, lite, with 256 MB of memory, 2 GB of disk and 1/16 of a vCPU. Its cost is Cloudflare's price for the memory and disk it reserves. CPU is billed only while it runs, about the same either way, so it is left out.",
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <img src="/images/mirage-icon-light.svg" alt="" className="tm-light-only h-4 w-4" />
          <img src="/images/mirage-icon-dark.svg" alt="" className="tm-dark-only h-4 w-4" />
          <span>{host}</span>
          {tip(
            "Mirage takes about 100 MB, which also fits a Cloudflare Worker's 128 MB. An idle terminal adds about 10 KB and an active one what its command holds. Mirage runs in the smallest Cloudflare container that fits, from lite up to standard-4, and adds containers past that.",
          )}
        </div>
      </div>

      <svg
        viewBox="0 0 680 190"
        role="img"
        aria-label={`${fleet} reserve ${reserved} of memory for ${money(sandboxCost)} a month. ${host} holds ${idle} idle and ${busy} active terminals for ${money(terminalCost)} a month.`}
        className="mt-3 w-full"
      >
        <g fill="var(--tm-reserved)">
          {marks.map((_, index) => (
            <rect
              key={index}
              x={left + (index % cols) * (cell + gap)}
              y={top + Math.floor(index / cols) * (cell + gap)}
              width={cell}
              height={cell}
              rx={corner}
              fill={index < busy ? "var(--tm-b)" : undefined}
            />
          ))}
        </g>
        {marks.map((_, index) =>
          index < busy ? (
            <circle
              key={index}
              cx={dotsLeft + (index % dotCols) * pitch}
              cy={dotsTop + Math.floor(index / dotCols) * pitch}
              r={radius}
              fill="var(--tm-b)"
            />
          ) : (
            <circle
              key={index}
              cx={dotsLeft + (index % dotCols) * pitch}
              cy={dotsTop + Math.floor(index / dotCols) * pitch}
              r={radius - 0.75}
              fill="none"
              stroke="var(--tm-a)"
              strokeWidth="1.5"
            />
          ),
        )}
        <g>
          <rect
            x={bar.x}
            y={bar.y}
            width={bar.w}
            height={bar.h}
            rx="3"
            fill="var(--tm-edge-soft)"
          />
          <rect x={bar.x} y={bar.y} width={baseW} height={bar.h} fill="var(--tm-base)" />
          <rect x={bar.x + baseW} y={bar.y} width={idleW} height={bar.h} fill="var(--tm-a)" />
          <rect x={bar.x + baseW + idleW} y={bar.y} width={busyW} height={bar.h} fill="var(--tm-b)" />
        </g>
        <g fill="none" stroke="var(--tm-base)">
          <rect x={zoom.x} y={zoom.y} width={zoom.w} height={zoom.h} rx="10" strokeWidth="1.5" />
        </g>
      </svg>

    </div>
  )
}

export const SandboxesVsTerminals = () => {
  const mark = (label, color, shape) => (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2.5 w-2.5 ${shape === "ring" ? "rounded-full border-2" : "rounded-sm"} ${
          shape === "outline" ? "border border-zinc-400 dark:border-zinc-500" : color ? "" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
        style={color ? (shape === "ring" ? { borderColor: color } : { background: color }) : undefined}
      />
      {label}
    </span>
  )
  const button = (label, onClick, pressed) => (
    <button
      key={label}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
        pressed
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-300 text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
      }`}
    >
      {label}
    </button>
  )
  const steps = [1, 5, 10, 25, 50, 100]
  const shares = [
    ["None", 0],
    ["1 in 10", 0.1],
    ["1 in 4", 0.25],
    ["Half", 0.5],
    ["All", 1],
  ]
  const sizes = [1, 4, 16]
  const [step, setStep] = useState(4)
  const [share, setShare] = useState(1)
  const [size, setSize] = useState(1)
  const agents = steps[step]
  const busy = Math.round(agents * shares[share][1])
  const idle = agents - busy
  const holds = sizes[size]

  const base = 100
  const idleMB = idle * 0.02
  const busyMB = busy * holds
  const used = base + idleMB + busyMB
  const over = used > 512

  const width = 300
  const height = 240
  const cols = [1, 5, 5, 9, 10, 20][step]
  const gap = agents >= 50 ? 3 : 5
  const cell = Math.min(44, (width - (cols - 1) * gap) / cols)
  const rows = Math.ceil(agents / cols)
  const left = (width - (cols * cell + (cols - 1) * gap)) / 2
  const top = (height - (rows * cell + (rows - 1) * gap)) / 2
  const corner = Math.min(3, cell / 5)

  const server = cell * 2 + gap
  const serverX = 380
  const serverY = 4
  const zoom = { x: 380, y: 108, w: 296, h: 130 }
  const pitch = agents <= 25 ? 16 : 11
  const radius = agents <= 25 ? 5 : 3.5
  const dotCols = Math.min(agents, Math.floor((zoom.w - 20) / pitch))
  const dotRows = Math.ceil(agents / dotCols)
  const dotsLeft = zoom.x + (zoom.w - (dotCols - 1) * pitch) / 2
  const dotsTop = zoom.y + 12 + (64 - (dotRows - 1) * pitch) / 2

  const bar = { x: zoom.x + 12, y: zoom.y + 88, w: zoom.w - 24, h: 14 }
  const scale = bar.w / Math.max(512, used)
  const baseW = base * scale
  const idleW = Math.max(idle ? 1 : 0, idleMB * scale)
  const busyW = busyMB * scale
  const limitX = bar.x + 512 * scale

  const megabytes = agents * 128
  const format = (mb) =>
    mb >= 1024 ? `${Number((mb / 1024).toFixed(1))} GB` : mb > 0 && mb < 1 ? "under 1 MB" : `${Math.round(mb)} MB`
  const reserved = format(megabytes)
  const plural = agents === 1 ? "" : "s"
  const count = agents.toLocaleString("en-US")
  const marks = Array.from({ length: agents })
  const strip = (index) => Math.max(1.5, (cell * (index < busy ? holds : 0.02)) / 128)
  const summary = over
    ? `needs ${format(used)}, more than the server has`
    : `${format(used)} of 512 MB in use`

  return (
    <div className="terminal-model not-prose my-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4">
      <style>{`
        .terminal-model { --tm-a: #2a78d6; --tm-b: #eb6834; --tm-refused: #d03b3b; }
        html.dark .terminal-model { --tm-a: #3987e5; --tm-b: #d95926; --tm-refused: #e66767; }
      `}</style>
      <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-900 dark:text-zinc-100">
        <label htmlFor="agent-count" className="font-semibold">
          Agents
        </label>
        <input
          id="agent-count"
          type="range"
          min="0"
          max={steps.length - 1}
          step="1"
          value={step}
          onChange={(event) => setStep(Number(event.target.value))}
          aria-valuetext={`${agents} agent${plural}`}
          className="w-48"
          style={{ accentColor: "var(--tm-a)" }}
        />
        <span className="tabular-nums">{count}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-900 dark:text-zinc-100">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Busy terminals">
          <span className="mr-1 font-semibold">Busy</span>
          {shares.map(([label], index) => button(label, () => setShare(index), share === index))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="What each busy terminal holds">
          <span className="mr-1 font-semibold">Each holds</span>
          {sizes.map((mb, index) => button(`${mb} MB`, () => setSize(index), size === index))}
        </div>
      </div>

      <svg
        viewBox="0 0 680 244"
        role="img"
        aria-label={`${agents} sandboxes reserve ${reserved} of memory. One 512 MB server holds ${idle} idle and ${busy} busy terminals and ${summary}.`}
        className="mt-3 w-full"
      >
        <g className="text-zinc-300 dark:text-zinc-700" fill="currentColor">
          {marks.map((_, index) => (
            <rect
              key={index}
              x={left + (index % cols) * (cell + gap)}
              y={top + Math.floor(index / cols) * (cell + gap)}
              width={cell}
              height={cell}
              rx={corner}
            />
          ))}
          {[0, 1, 2, 3].map((index) => (
            <rect
              key={index}
              x={serverX + (index % 2) * (cell + gap)}
              y={serverY + Math.floor(index / 2) * (cell + gap)}
              width={cell}
              height={cell}
              rx={corner}
            />
          ))}
        </g>
        <text
          x={serverX + server + 10}
          y={serverY + 12}
          fontSize="12"
          fill="currentColor"
          className="text-zinc-600 dark:text-zinc-400"
        >
          one server, at the same scale
        </text>
        {marks.map((_, index) => (
          <rect
            key={index}
            x={left + (index % cols) * (cell + gap)}
            y={top + Math.floor(index / cols) * (cell + gap) + cell - strip(index)}
            width={cell}
            height={strip(index)}
            fill={index < busy ? "var(--tm-b)" : "var(--tm-a)"}
          />
        ))}
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
            className="text-zinc-100 dark:text-zinc-800"
            fill="currentColor"
          />
          <rect x={bar.x} y={bar.y} width={baseW} height={bar.h} className="text-zinc-400 dark:text-zinc-500" fill="currentColor" />
          <rect x={bar.x + baseW} y={bar.y} width={idleW} height={bar.h} fill="var(--tm-a)" />
          <rect x={bar.x + baseW + idleW} y={bar.y} width={busyW} height={bar.h} fill="var(--tm-b)" />
          {over && (
            <g>
              <line
                x1={limitX}
                x2={limitX}
                y1={bar.y - 4}
                y2={bar.y + bar.h + 4}
                stroke="var(--tm-refused)"
                strokeWidth="2"
              />
              <text x={limitX} y={bar.y - 7} fontSize="10" textAnchor="middle" fill="var(--tm-refused)">
                512 MB
              </text>
            </g>
          )}
          <text
            x={bar.x}
            y={bar.y + bar.h + 16}
            fontSize="11"
            fill="currentColor"
            className="text-zinc-600 dark:text-zinc-400"
          >
            {`Mirage ${base} MB · idle ${format(idleMB)} · busy ${format(busyMB)}`}
          </text>
        </g>
        <g className="text-zinc-400 dark:text-zinc-500" fill="none" stroke="currentColor">
          <rect x={zoom.x} y={zoom.y} width={zoom.w} height={zoom.h} rx="10" strokeWidth="1.5" />
          <path
            d={`M${serverX} ${serverY + server} L${zoom.x} ${zoom.y + 10} M${serverX + server} ${serverY + server} L${zoom.x + zoom.w} ${zoom.y + 10}`}
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        </g>
      </svg>

      <div className="mt-2 grid grid-cols-2 gap-6 text-sm">
        <div>
          <div className="font-semibold text-zinc-900 dark:text-zinc-100">A sandbox for each agent</div>
          <div className="text-zinc-600 dark:text-zinc-400">
            {count} machine{plural}, {reserved} reserved, busy or idle
          </div>
        </div>
        <div>
          <div className="font-semibold text-zinc-900 dark:text-zinc-100">Terminals in one server</div>
          <div className="text-zinc-600 dark:text-zinc-400" style={over ? { color: "var(--tm-refused)" } : undefined}>
            1 server, {idle} idle and {busy} busy, {summary}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {mark("128 MB of memory, reserved")}
        {mark("idle terminal with no files kept, about 20 KB", "var(--tm-a)", "ring")}
        {mark("busy terminal: its files, cache and buffers", "var(--tm-b)")}
        {mark("the server, enlarged", null, "outline")}
      </div>
    </div>
  )
}

export const WaitingOrWorking = () => {
  const mark = (label, color, opacity, outline) => (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-sm ${
          outline ? "border border-zinc-400 dark:border-zinc-500" : color ? "" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
        style={color ? { background: color, opacity } : undefined}
      />
      {label}
    </span>
  )
  const button = (label, onClick, pressed) => (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        pressed
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-300 text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
      }`}
    >
      {label}
    </button>
  )
  const [mode, setMode] = useState("waiting")
  const [run, setRun] = useState(0)
  const [progress, setProgress] = useState(1)

  useEffect(() => {
    if (run === 0) return undefined
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1)
      return undefined
    }
    const started = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const next = Math.min(1, (now - started) / 2600)
      setProgress(next)
      if (next < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [run])

  const play = (next) => {
    setMode(next)
    setProgress(0)
    setRun((value) => value + 1)
  }

  const span = 4.3
  const plot = { x: 96, w: 572 }
  const at = (time) => plot.x + (time / span) * plot.w
  const lane = (index) => 8 + index * 30
  const cpuLane = lane(4) + 10
  const bar = 20

  const segments = []
  if (mode === "waiting") {
    for (let index = 0; index < 4; index += 1) {
      const start = index * 0.05
      segments.push({ lane: lane(index), from: start, to: start + 0.05, kind: "cpu" })
      segments.push({ lane: lane(index), from: start + 0.05, to: start + 1, kind: "reply" })
      segments.push({ lane: lane(index), from: start + 1, to: start + 1.05, kind: "cpu" })
    }
    segments.push({ lane: cpuLane, from: 0, to: 0.2, kind: "cpu" })
    segments.push({ lane: cpuLane, from: 1, to: 1.2, kind: "cpu" })
  } else {
    for (let index = 0; index < 4; index += 1) {
      segments.push({ lane: lane(index), from: 0, to: 3.5 + (index + 1) * 0.125, kind: "queue" })
    }
    for (let slice = 0; slice < 32; slice += 1) {
      segments.push({ lane: lane(slice % 4), from: slice * 0.125, to: (slice + 1) * 0.125, kind: "cpu" })
    }
    segments.push({ lane: cpuLane, from: 0, to: 4, kind: "cpu" })
  }
  const now = progress * span
  const summary =
    mode === "waiting"
      ? "All four commands finish in about the time one takes alone. The CPU is free while they wait."
      : "The four commands share the CPU, so each takes about four times as long as it would alone."

  return (
    <div className="terminal-model not-prose my-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4">
      <style>{`
        .terminal-model { --tm-a: #2a78d6; --tm-b: #eb6834; --tm-refused: #d03b3b; }
        html.dark .terminal-model { --tm-a: #3987e5; --tm-b: #d95926; --tm-refused: #e66767; }
      `}</style>
      <div className="flex flex-wrap items-center gap-2">
        {button("Four commands wait on a service", () => play("waiting"), mode === "waiting")}
        {button("Four commands work on data", () => play("working"), mode === "working")}
      </div>

      <svg viewBox="0 0 680 190" role="img" aria-label={summary} className="mt-3 w-full">
        <defs>
          <clipPath id="waiting-or-working-played">
            <rect x={plot.x} y="0" width={Math.max(0, at(now) - plot.x)} height="190" />
          </clipPath>
        </defs>
        <g fontSize="12" fill="currentColor" className="text-zinc-600 dark:text-zinc-400">
          {[1, 2, 3, 4].map((terminal, index) => (
            <text key={terminal} x="0" y={lane(index) + 14}>
              terminal {terminal}
            </text>
          ))}
          <text x="0" y={cpuLane + 14} fontWeight="600">
            the CPU
          </text>
          {[0, 1, 2, 3, 4].map((tick) => (
            <text key={tick} x={at(tick)} y="186" textAnchor={tick === 0 ? "start" : "middle"}>
              {tick === 0 ? "start" : `${tick}×`}
            </text>
          ))}
        </g>
        <g className="text-zinc-200 dark:text-zinc-800" stroke="currentColor" strokeWidth="1">
          {[0, 1, 2, 3, 4].map((tick) => (
            <line key={tick} x1={at(tick)} y1="4" x2={at(tick)} y2={cpuLane + bar + 6} />
          ))}
        </g>
        <g clipPath="url(#waiting-or-working-played)">
          <g className="text-zinc-300 dark:text-zinc-700" fill="currentColor">
            {segments
              .filter((segment) => segment.kind === "queue")
              .map((segment, index) => (
                <rect
                  key={index}
                  x={at(segment.from)}
                  y={segment.lane}
                  width={at(segment.to) - at(segment.from)}
                  height={bar}
                  rx="3"
                />
              ))}
          </g>
          <g fill="var(--tm-a)">
            {segments
              .filter((segment) => segment.kind !== "queue")
              .map((segment, index) => (
                <rect
                  key={index}
                  x={at(segment.from)}
                  y={segment.lane}
                  width={at(segment.to) - at(segment.from)}
                  height={bar}
                  rx={segment.kind === "reply" ? 3 : 0}
                  opacity={segment.kind === "reply" ? 0.28 : 1}
                />
              ))}
          </g>
        </g>
        {progress < 1 && (
          <line
            x1={at(now)}
            y1="2"
            x2={at(now)}
            y2={cpuLane + bar + 6}
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-zinc-900 dark:text-zinc-100"
          />
        )}
      </svg>

      <p className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">{summary}</p>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {mark("using the CPU", "var(--tm-a)")}
        {mark("waiting for a reply", "var(--tm-a)", 0.28)}
        {mark("waiting for the CPU")}
        <span>1× is the time one command takes alone</span>
      </div>
    </div>
  )
}

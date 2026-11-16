export const UseCaseTerminal = ({ services, steps, extras = [], reads = "The agent reads and writes", terminal = "Runs in one terminal", server = "its own server, or a library in your app" }) => {
  const [pos, setPos] = useState({ step: steps.length, chars: 0, output: true })

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined
    }
    let timer
    let step = 0
    let chars = 0
    const tick = () => {
      if (step >= steps.length) {
        setPos({ step: steps.length, chars: 0, output: true })
        timer = setTimeout(() => {
          step = 0
          chars = 0
          tick()
        }, 3500)
        return
      }
      const cmd = steps[step].cmd
      if (chars < cmd.length) {
        chars += 1
        setPos({ step, chars, output: false })
        timer = setTimeout(tick, 26)
        return
      }
      setPos({ step, chars, output: true })
      timer = setTimeout(() => {
        step += 1
        chars = 0
        tick()
      }, 1500)
    }
    setPos({ step: 0, chars: 0, output: false })
    timer = setTimeout(tick, 700)
    return () => clearTimeout(timer)
  }, [])

  const running = pos.step < steps.length && pos.output ? steps[pos.step].cli : null
  const typing = pos.step < steps.length ? steps[pos.step].cli : null
  const flow = (service) => {
    const step = pos.step < steps.length ? steps[pos.step] : null
    return (step && step.cli === service.cli && step.dir) || service.dir || "in"
  }
  const tokens = (text) => {
    const out = []
    let command = true
    for (const part of text.match(/"[^"]*"?|'[^']*'?|\$\w+|\s+|[;&|>]+|[^\s;&|>"']+/g) || []) {
      let kind = "plain"
      if (/^\s+$/.test(part)) kind = "plain"
      else if (part.startsWith('"') || part.startsWith("'")) kind = "string"
      else if (part.startsWith("$")) kind = "variable"
      else if (/^[;&|>]+$/.test(part)) {
        kind = "operator"
        command = true
      } else if (part.startsWith("-")) kind = "flag"
      else if (command) {
        kind = "command"
        command = false
      }
      out.push([part, kind])
    }
    return out
  }
  const colored = (text, key) =>
    tokens(text).map(([part, kind], index) => (
      <span key={`${key}-${index}`} className={`uct-${kind}`}>
        {part}
      </span>
    ))

  return (
    <div className="use-case-terminal not-prose my-6 rounded-2xl">
      <style>{`
        .use-case-terminal {
          --uct-paper: #f0ece2; --uct-surface: #faf8f2; --uct-edge: #cec6b3;
          --uct-ink: #0a0a0a; --uct-muted: #5b5647; --uct-accent: #047857; --uct-on: #b08a2e;
          background: var(--uct-paper); color: var(--uct-ink); padding: 28px 14px;
        }
        html.dark .use-case-terminal {
          --uct-paper: #0e0e10; --uct-surface: #1a1a1d; --uct-edge: #3f3f46;
          --uct-ink: #ffffff; --uct-muted: #a1a1aa; --uct-accent: #34d399; --uct-on: #c9a03e;
        }
        .use-case-terminal img { margin: 0; display: block; }
        .use-case-terminal .uct-box { background: var(--uct-surface); border: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-muted { color: var(--uct-muted); }
        .use-case-terminal .uct-grid { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
        .use-case-terminal .uct-server { order: -1; }
        .use-case-terminal .uct-wire { display: none; }
        .use-case-terminal .uct-card { transition: border-color .25s; }
        .use-case-terminal .uct-card.uct-on { border-color: var(--uct-on); }
        .use-case-terminal .uct-chip { border: 1px solid var(--uct-edge); color: var(--uct-muted); transition: color .25s, border-color .25s; }
        .use-case-terminal .uct-chip.uct-on { border-color: var(--uct-on); color: var(--uct-on); }
        .use-case-terminal .uct-wire-line { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--uct-edge); transition: border-color .25s; }
        .use-case-terminal .uct-wire.uct-on .uct-wire-line { border-color: var(--uct-on); }
        .use-case-terminal .uct-dot { position: absolute; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 9999px; background: var(--uct-on); opacity: 0; }
        .use-case-terminal .uct-wire.uct-on.uct-in .uct-dot { animation: uct-in .7s linear infinite; }
        .use-case-terminal .uct-wire.uct-on.uct-out .uct-dot { animation: uct-out .7s linear infinite; }
        @keyframes uct-in { 0% { left: 0; opacity: 1; } 100% { left: calc(100% - 6px); opacity: 1; } }
        @keyframes uct-out { 0% { left: calc(100% - 6px); opacity: 1; } 100% { left: 0; opacity: 1; } }
        .use-case-terminal .uct-bar { border-bottom: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-light { width: 8px; height: 8px; border-radius: 9999px; border: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-prompt { color: var(--uct-accent); }
        .use-case-terminal .uct-caret { display: inline-block; width: 7px; height: 14px; margin-left: 1px; vertical-align: -2px; background: var(--uct-ink); animation: uct-blink 1s steps(1) infinite; }
        @keyframes uct-blink { 50% { opacity: 0; } }
        .use-case-terminal .uct-later { visibility: hidden; }
        .use-case-terminal .uct-operator { color: #cf222e; }
        .use-case-terminal .uct-command { color: #953800; }
        .use-case-terminal .uct-flag { color: #0550ae; }
        .use-case-terminal .uct-string { color: #0a3069; }
        .use-case-terminal .uct-variable { color: #8250df; }
        html.dark .use-case-terminal .uct-operator { color: #ff7b72; }
        html.dark .use-case-terminal .uct-command { color: #ffa657; }
        html.dark .use-case-terminal .uct-flag { color: #79c0ff; }
        html.dark .use-case-terminal .uct-string { color: #a5d6ff; }
        html.dark .use-case-terminal .uct-variable { color: #d2a8ff; }
        .use-case-terminal .uct-dark-only { display: none; }
        html.dark .use-case-terminal .uct-dark-only { display: block; }
        html.dark .use-case-terminal .uct-light-only { display: none; }
        .use-case-terminal .uct-none { display: flex; flex-direction: column; gap: 2px; border: 1px dashed var(--uct-edge); }
        .use-case-terminal .uct-none-name { white-space: nowrap; text-decoration: line-through; }
        @media (min-width: 640px) {
          .use-case-terminal { padding: 36px 28px; }
          .use-case-terminal .uct-grid {
            grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1.75fr);
            grid-auto-rows: auto;
            align-items: center;
            column-gap: 0;
          }
          .use-case-terminal .uct-head { grid-column: 1; grid-row: 1; }
          .use-case-terminal .uct-server { order: 0; grid-column: 3; grid-row: 1 / span var(--uct-span); align-self: stretch; }
          .use-case-terminal .uct-wire { display: block; position: relative; height: 12px; grid-column: 2; grid-row: var(--uct-row); }
          .use-case-terminal .uct-card { grid-column: 1; grid-row: var(--uct-row); }
          .use-case-terminal .uct-none { flex-direction: row; align-items: center; gap: 12px; }
        }
      `}</style>

      <div className="uct-grid">
        <div className="uct-head uct-muted mb-1 text-xs font-medium">{reads}</div>
        {services.map((service, index) => [
          <div
            key={service.cli + "-card"}
            className={"uct-card uct-box rounded-lg px-3 py-2" + (running === service.cli ? " uct-on" : "")}
            style={{ "--uct-row": index + 2 }}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{service.name}</span>
              <span className={"uct-chip rounded px-1.5 font-mono text-xs" + (typing === service.cli ? " uct-on" : "")}>
                {service.cli}
              </span>
            </div>
            <div className="uct-muted mt-0.5 text-xs">
              {service.text || (service.dir === "out" ? "writes " : "reads ") + service.detail}
            </div>
          </div>,
          <div
            key={service.cli + "-wire"}
            className={"uct-wire " + (flow(service) === "out" ? "uct-out" : "uct-in") + (running === service.cli ? " uct-on" : "")}
            style={{ "--uct-row": index + 2 }}
            aria-hidden="true"
          >
            <div className="uct-wire-line" />
            <div className="uct-dot" />
          </div>,
        ])}

        <div className="uct-server uct-box rounded-xl p-3" style={{ "--uct-span": services.length + 1 }}>
          <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <img src="/logo/light.svg" alt="mirage" className="uct-light-only" style={{ height: 18, width: "auto" }} />
            <img src="/logo/dark.svg" alt="mirage" className="uct-dark-only" style={{ height: 18, width: "auto" }} />
            <span className="text-sm font-medium">{terminal}</span>
            <span className="uct-muted text-xs">{server}</span>
          </div>
          <div className="uct-box overflow-hidden rounded-lg">
            <div className="uct-bar flex items-center gap-1.5 px-3 py-1.5">
              <span className="uct-light" />
              <span className="uct-light" />
              <span className="uct-light" />
            </div>
            <div className="px-3 py-2 font-mono text-xs leading-5">
              {steps.map((step, index) => {
                const later = index > pos.step
                const current = index === pos.step
                const text = current ? step.cmd.slice(0, pos.chars) : step.cmd
                const showOut = index < pos.step || (current && pos.output)
                return (
                  <div key={step.cmd} className={later ? "uct-later" : ""}>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">
                      <span className="uct-prompt select-none">$ </span>
                      {colored(later ? step.cmd : text, index)}
                      {current && !pos.output && <span className="uct-caret" />}
                    </div>
                    <div className={"uct-muted overflow-hidden text-ellipsis whitespace-nowrap" + (showOut || later ? "" : " uct-later")}>
                      {step.out}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          {extras.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {extras.map((extra) => (
                <span
                  key={extra.text}
                  className={"uct-chip rounded px-1.5 font-mono text-xs" + (extra.cli && running === extra.cli ? " uct-on" : "")}
                >
                  {extra.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="uct-none mt-4 rounded-lg px-3 py-2">
        <span className="uct-none-name uct-muted text-sm">Sandbox, container or VM</span>
        <span className="uct-muted text-xs">Not needed: the terminal runs inside the server process.</span>
      </div>
    </div>
  )
}

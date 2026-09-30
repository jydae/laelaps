import { html, useEffect, useRef, useState, Button, Ornament, Field, ToggleRow, MenuPop, Caret, useDismiss, Logo, reveal, Popover, Menu, MenuItem, dropdown, mark, THEMES, currentTheme, applyTheme, useTheme, useTick, Tabs, Tab, PanelBoundary } from "../ui/index.js";
import { listProjects, createProject, openProject, updateSettings, closeProject, deleteProject, currentSession } from "../core/index.js";

const opened = (iso) => {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const today = new Date().toDateString() === at.toDateString();
  return today ? `Today ${at.toTimeString().slice(0, 5)}`
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

function OpenList({ projects, onOpen }) {
  const [chosen, setChosen] = useState(projects[0]?.id ?? null);
  const [password, setPassword] = useState("");
  const [fault, setFault] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickRef = useRef(null);
  useDismiss(pickRef, picking, () => setPicking(false));
  const project = projects.find((p) => p.id === chosen);

  const unlock = async () => {
    if (!chosen || !password || busy) return;
    setBusy(true);
    try { onOpen(await openProject(chosen, password)); }
    catch (e) { setFault(e.message); setPassword(""); setBusy(false); }
  };

  return html`<div className="gate-form">
    <div className="field picker" ref=${pickRef}>
      <span className="label">Project</span>
      <button type="button" className="field-box gate-pick-box" aria-haspopup="menu" aria-expanded=${picking}
        onClick=${() => setPicking(!picking)}>
        <span className="gate-pick-name">${project?.name ?? ""}</span><${Caret} open=${picking} />
      </button>
      ${picking && html`<${MenuPop} className="gate-pick-menu"
        items=${projects.map((p) => ({ id: p.id, label: p.name, note: opened(p.opened), plain: true, active: p.id === chosen }))}
        onPick=${(id) => { setChosen(id); setPicking(false); setFault(null); setPassword(""); }} />`}
    </div>
    <${Field} label="Password" type="password" value=${password} autoFocus=${true}
      onChange=${(v) => { setPassword(v); setFault(null); }} onEnter=${unlock} />
    ${project && html`<div className="note gate-hint">Opened by ${project.user}, ${opened(project.opened).replace("Today", "today at")}.</div>`}
    ${fault && html`<div className="label gate-fault">${fault}</div>`}
    <div className="gate-foot"><${Button} text="Open" onClick=${unlock} disabled=${!password || busy} /></div>
  </div>`;
}

function NewForm({ onOpen }) {
  const [form, setForm] = useState({ name: "", user: "", password: "", confirm: "", timer: true, challenges: false });
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const [fault, setFault] = useState(null);
  const [busy, setBusy] = useState(false);

  const ready = form.name.trim() && form.user.trim() && form.password.length >= 8 && form.password === form.confirm;
  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const { confirm, ...body } = form;
      onOpen(await createProject(body));
    } catch (e) { setFault(e.message); setBusy(false); }
  };

  return html`<div className="gate-form">
    <${Field} label="Project name" value=${form.name} onChange=${set("name")} autoFocus=${true} onEnter=${create} />
    <${Field} label="Name" value=${form.user} onChange=${set("user")} onEnter=${create} />
    <${Field} label="Password" type="password" value=${form.password} onChange=${set("password")}
      placeholder="At least 8 characters" onEnter=${create} />
    <${Field} label="Confirm password" type="password" value=${form.confirm} onChange=${set("confirm")}
      placeholder=${form.confirm && form.confirm !== form.password ? "Does not match" : "Type it again"} onEnter=${create} />
    <${ToggleRow} name="Timer" note="Counts from the moment the project is opened." on=${form.timer} onToggle=${() => set("timer")(!form.timer)} />
    <${ToggleRow} name="Mysteries" note="The tab and its cases. Off removes the tab." on=${form.challenges} onToggle=${() => set("challenges")(!form.challenges)} />
    ${fault && html`<div className="label gate-fault">${fault}</div>`}
    <div className="gate-foot"><${Button} text="Create and open" onClick=${create} disabled=${!ready || busy} /></div>
  </div>`;
}

function StartPage({ onOpen }) {
  const [projects, setProjects] = useState(null);
  const [fault, setFault] = useState(null);
  const [mode, setMode] = useState(null);

  useEffect(() => {
    listProjects()
      .then((list) => { setProjects(list); setMode(list.length ? "open" : "new"); })
      .catch((e) => { setFault(`The projects could not be read: ${e.message}`); setProjects([]); setMode("new"); });
  }, []);

  const strip = (id, title) => html`<button type="button" className=${"gate-strip-cell" + (mode === id ? " is-on" : "")}
    aria-pressed=${mode === id} onClick=${() => setMode(id)} disabled=${projects?.length === 0 && id === "open"}>${title}</button>`;

  return html`<div className="gate">
    <${Ornament} className="ornament--gate">
      <div className="gate-ident">
        <${Logo} size="128" className="gate-logo" />
        <div className="gate-wordmark">Laelaps</div>
      </div>
      <div className="gate-strip">${strip("open", "Open")}${strip("new", "New")}</div>
      ${fault && html`<div className="label gate-fault">${fault}</div>`}
      ${mode === "open" && projects && html`<${OpenList} projects=${projects} onOpen=${onOpen} />`}
      ${mode === "new" && html`<${NewForm} onOpen=${onOpen} />`}
      ${mode === null && html`<div className="label">Loading…</div>`}
    <//>
  </div>`;
}

const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25];

function Line({ label, stored, verb, onSave }) {
  const [value, setValue] = useState(stored ?? "");
  const [fault, setFault] = useState(null);
  const changed = value.trim() && value !== stored;
  const save = async () => {
    if (!changed) return;
    try { await onSave(value.trim()); setFault(null); }
    catch (e) { setFault(e.message); }
  };
  return html`<div className="settings-line">
    <${Field} label=${label} value=${value} onChange=${setValue} onEnter=${save} />
    <${Button} text=${verb} onClick=${save} disabled=${!changed} />
    ${fault && html`<div className="label gate-fault">${fault}</div>`}
  </div>`;
}

function ThemeRow() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const chosen = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  return html`<div className="switch settings-theme">
    <span className="switch-text">
      <span className="name">Theme</span>
      <span className="note">${chosen.note}</span>
    </span>
    <${Popover} ...${dropdown} placement="bottom-end" isOpen=${open} onInteraction=${setOpen}
      content=${html`<${Menu}>
        ${THEMES.map((t) => html`<${MenuItem} key=${t.id} text=${t.name}
          roleStructure="listoption" selected=${t.id === currentTheme()}
          onClick=${() => applyTheme(t.id)} />`)}
      <//>`}>
      <${Button} small text=${chosen.name} rightIcon=${mark(open ? "chevron-up" : "chevron-down")} active=${open} />
    <//>
  </div>`;
}

function SettingsPanel({ anchor, session, zoom, onZoom, onChange, onClose, onLocked }) {

  useDismiss(anchor, true, onClose, { portal: ".bp5-popover" });
  const write = (changes) => updateSettings(changes).then(onChange);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  const [passNote, setPassNote] = useState(null);
  const changePassword = async () => {
    if (!current || next.length < 8) return;
    try { await write({ password: current, newPassword: next }); setCurrent(""); setNext(""); setPassNote({ text: "Password changed.", fault: false }); }
    catch (e) { setPassNote({ text: e.message, fault: true }); }
  };

  const [settingFault, setSettingFault] = useState(null);
  const toggle = (changes) => { setSettingFault(null); write(changes).catch((e) => setSettingFault(e.message)); };

  const [lockFault, setLockFault] = useState(null);
  const lock = () => closeProject().then(onLocked).catch((e) => (e.status === 401
    ? onLocked()
    : setLockFault(`The project could not be locked: ${e.message}`)));

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePass, setDeletePass] = useState("");
  const [deleteFault, setDeleteFault] = useState(null);
  const remove = async () => {
    if (!deletePass) return;
    try { await deleteProject(deletePass); onLocked(); }
    catch (e) { setDeleteFault(e.message); setDeletePass(""); }
  };

  const at = ZOOM_STEPS.indexOf(zoom);

  return html`<div className="menu-pop settings-pop" ref=${reveal}>
    <div className="settings-section">
      <${Line} label="Project" stored=${session.name} verb="Rename" onSave=${(name) => write({ name })} />
      <${Line} label="Name" stored=${session.user} verb="Change" onSave=${(user) => write({ user })} />
    </div>
    <div className="menu-divider"></div>
    <div className="settings-section">
      <${Field} label="Current password" type="password" value=${current} onChange=${(v) => { setCurrent(v); setPassNote(null); }} />
      <div className="settings-line">
        <${Field} label="New password" type="password" value=${next} placeholder="At least 8 characters"
          onChange=${(v) => { setNext(v); setPassNote(null); }} onEnter=${changePassword} />
        <${Button} text="Change" onClick=${changePassword} disabled=${!current || next.length < 8} />
      </div>
      ${passNote && html`<div className=${"label " + (passNote.fault ? "gate-fault" : "gate-note")}>${passNote.text}</div>`}
    </div>
    <div className="menu-divider"></div>
    <div className="settings-section">
      <${ToggleRow} name="Timer" note="Counts from the moment the project is opened." on=${session.timer}
        onToggle=${() => toggle({ timer: !session.timer })} />
      <${ToggleRow} name="Mysteries" note="The tab and its cases." on=${session.challenges}
        onToggle=${() => toggle({ challenges: !session.challenges })} />
      ${settingFault && html`<div className="label gate-fault">${settingFault}</div>`}
      <${ThemeRow} />
      <div className="switch">
        <span className="switch-text"><span className="name">Zoom</span></span>
        <span className="settings-zoom-pair">
          <button className="zoom-glyph" title="Zoom out" onClick=${() => onZoom(ZOOM_STEPS[at - 1])} disabled=${at <= 0}>−</button>
          <span className="mono">${Math.round(zoom * 100)}%</span>
          <button className="zoom-glyph" title="Zoom in" onClick=${() => onZoom(ZOOM_STEPS[at + 1])} disabled=${at >= ZOOM_STEPS.length - 1}>+</button>
        </span>
      </div>
    </div>
    <div className="menu-divider"></div>
    <div className="settings-section settings-actions">
      <${Button} text="Lock project" onClick=${lock} />
      ${lockFault && html`<div className="label gate-fault">${lockFault}</div>`}
      ${confirmDelete
        ? html`<div className="settings-line" ref=${reveal}>
            <${Field} label="Password to delete this project" type="password" value=${deletePass} autoFocus=${true}
              onChange=${(v) => { setDeletePass(v); setDeleteFault(null); }} onEnter=${remove} />
            <${Button} text="Delete" onClick=${remove} disabled=${!deletePass} />
            ${deleteFault && html`<div className="label gate-fault">${deleteFault}</div>`}
          </div>`
        : html`<${Button} text="Delete project" onClick=${() => setConfirmDelete(true)} />`}
    </div>
  </div>`;
}

const elapsed = (since) => {
  const s = Math.floor(Math.max(0, Date.now() - since) / 1000);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
};

const GEAR = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3"></circle>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
</svg>`;

function Timer({ since }) {
  const timerRef = useRef(null);
  useTick(() => {
    if (timerRef.current) timerRef.current.textContent = elapsed(since);
  }, 1000);
  return html`<div className="bar-cell bar-timer" title="Since the project was opened">
    <span className="mono readout-v" ref=${timerRef}>${elapsed(since)}</span>
  </div>`;
}

export function App({ modules }) {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    currentSession().then(setSession).catch(() => setSession(null));
    const lost = () => setSession(null);
    window.addEventListener("session-lost", lost);
    return () => window.removeEventListener("session-lost", lost);
  }, []);
  if (session === undefined) return null;
  if (!session) return html`<${StartPage} onOpen=${setSession} />`;
  return html`<${Console} key=${session.id} session=${session} modules=${modules} onSession=${setSession} />`;
}

function Console({ session, modules, onSession }) {

  const tabs = modules.filter((module) => module.enabled(session));
  const home = tabs[0]?.id ?? null;
  const [tab, setTab] = useState(home);

  const [alive, setAlive] = useState(() => new Set([home]));
  const show = (id) => {
    setAlive((was) => (was.has(id) ? was : new Set(was).add(id)));
    setTab(id);
  };

  useEffect(() => { if (!tabs.some((module) => module.id === tab)) setTab(home); }, [tabs.map((m) => m.id).join()]);

  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    document.documentElement.style.setProperty("--zoom", String(zoom));
    window.dispatchEvent(new Event("resize"));
  }, [zoom]);
  const [settings, setSettings] = useState(false);
  const gear = useRef(null);

  return html`<div className="console">
    <header className="topbar">
      <div className="bar-cell bar-logo"><${Logo} size="44" /></div>
      <${Tabs} id="nav" className="lae-rail" large=${false}
               selectedTabId=${tab}
               onChange=${show}
               renderActiveTabPanelOnly=${true}>
        ${tabs.map(
          ({ id, title, motif }) => html`<${Tab} id=${id} key=${id}
            title=${html`<span className="tab-face">
              <svg className="tab-motif tab-motif--rest" viewBox="0 0 176 56" aria-hidden="true">${motif}</svg>
              <svg className="tab-motif tab-motif--lit" viewBox="0 0 176 56" aria-hidden="true">${motif}</svg><span>${title}</span>
            </span>`} />`,
        )}
      <//>
      <div className="bar-air"></div>
      ${session.timer && html`<${Timer} since=${Date.parse(session.openedAt) || Date.now()} />`}
      <div className="bar-cell bar-user"><span className="mono">${session.user}</span></div>
      <span className="settings-anchor" ref=${gear}>
        <button className=${"bar-cell bar-config" + (settings ? " is-on" : "")} title="Settings"
          aria-expanded=${settings} onClick=${() => setSettings(!settings)}>${GEAR}</button>
        ${settings && html`<${SettingsPanel} anchor=${gear} session=${session} zoom=${zoom} onZoom=${setZoom}
          onChange=${onSession} onClose=${() => setSettings(false)} onLocked=${() => onSession(null)} />`}
      </span>
    </header>

    ${ ""}
    ${tabs
      .filter(({ id }) => alive.has(id))
      .map(({ id, Panel }) => html`
        <${PanelBoundary} key=${id} hidden=${id !== tab}>
          <${Panel} onOpen=${show} />
        <//>`)}
  </div>`;
}

import { html, useEffect, useRef, useState, Button, Ornament, Figure, ConfirmDialog } from "../../ui/index.js";
import { count, NA, json, listDatabases, useViewState, defineModule } from "../../core/index.js";
import { ingestBatch } from "../ingestor/index.js";
import { aimGraph } from "../graph/index.js";

const CHALLENGES = "/challenges";
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const manifestOf = (id) => json(`${CHALLENGES}/${id}/manifest.json`);

const normalise = (text) => text.trim().toLowerCase().split(/\s+/).join(" ");
const digest = async (text) => {
  const bytes = new TextEncoder().encode(normalise(text));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const BLANK = { challenge: null, step: 0, hints: [], answers: [], loaded: {} };
const CLOSED = { challenge: null, step: 0, hints: [], answers: [] };

const prose = (text) => text.split("`").map((part, i) => (i % 2 ? html`<code className="mono" key=${i}>${part}</code>` : part));

const snapshot = (m) => {
  const stamp = /^(\d{4})(\d{2})(\d{2})/.exec(m.files[0] ?? "");
  return stamp ? new Date(Date.UTC(+stamp[1], stamp[2] - 1, +stamp[3])).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : NA;
};

const filesOf = (m) => Promise.all(m.files.map(async (name) => {
  const res = await fetch(`${CHALLENGES}/${m.id}/${name}`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return new File([await res.blob()], name, { type: "application/json" });
}));

const Hint = ({ hint, open, onOpen }) => html`<div className="hint">
  <div className="hint-head">
    <span className="label hint-technique">${hint.technique}</span>
    ${!open && html`<button className="hint-reveal label" onClick=${onOpen}>Reveal</button>`}
  </div>
  ${open && html`<p className="hint-text">${prose(hint.text)}</p>`}
</div>`;

function Question({ index, question, hints, onHint, onRight }) {
  const [text, setText] = useState("");
  const [wrong, setWrong] = useState(false);
  const field = useRef(null);
  useEffect(() => { field.current?.focus(); }, [index]);
  const check = async () => {
    if (!text.trim()) return;
    const hash = await digest(text);
    if (question.answers.includes(hash)) { setWrong(false); onRight(text.trim()); setText(""); return; }
    setWrong(true);
    setText("");
  };
  return html`<div className="inquiry-line inquiry-line--current">
    <div className="inquiry-ask">
      <span className="inquiry-index">${index + 1}</span>
      <span className="inquiry-question">${question.ask}</span>
    </div>
    <div className="inquiry-body">
      ${question.hints.map((hint, i) => html`<${Hint} key=${i} hint=${hint}
        open=${hints.includes(`${index}:${i}`)} onOpen=${() => onHint(`${index}:${i}`)} />`)}
      <div className="answer">
        <input className="answer-field mono" ref=${field} value=${text} spellcheck="false"
          placeholder=${wrong ? "Not that. Look again." : ""}
          onInput=${(e) => { setText(e.target.value); setWrong(false); }}
          onKeyDown=${(e) => { if (e.key === "Enter") check(); }} />
        <${Button} text="Answer" onClick=${check} disabled=${text.trim().length === 0} />
      </div>
    </div>
  </div>`;
}

function MysteriesPanel({ onOpen }) {
  const [saved, save, ready] = useViewState("mysteries", BLANK);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [abandoning, setAbandoning] = useState(false);

  useEffect(() => {
    let live = true;
    json(`${CHALLENGES}/index.json`)
      .then((ids) => Promise.all(ids.map(manifestOf)))
      .then((manifests) => { if (live) setList(manifests); })
      .catch((e) => { if (live) setError(`The cases could not be read: ${e.message}`); });
    return () => { live = false; };
  }, []);

  const manifest = list?.find((m) => m.id === saved.challenge) ?? null;
  const db = saved.loaded[saved.challenge] ?? null;

  useEffect(() => {
    if (!ready || !db) return;
    let live = true;
    listDatabases()
      .then((dbs) => { if (live) setMissing(!dbs.some((d) => d.id === db)); })
      .catch(() => {});
    return () => { live = false; };
  }, [ready, db]);

  const open = async (m) => {
    setError(null);
    setLoading(true);
    try {
      let into = saved.loaded[m.id] ?? null;
      if (into && !(await listDatabases()).some((d) => d.id === into)) into = null;
      if (!into) {
        const r = await ingestBatch(await filesOf(m), { name: m.title });
        if (!r?.db) throw new Error(r?.note ?? "nothing was ingested");

        if (r.fault) setError(`The case loaded with problems: ${r.note}`);
        into = r.db;
      }
      save({ ...(m.id === saved.challenge ? {} : CLOSED), challenge: m.id, loaded: { ...saved.loaded, [m.id]: into } });
      setMissing(false);
    } catch (e) {
      setError(`The case could not be loaded: ${e.message}`);
    }
    setLoading(false);
  };

  const investigate = async () => {
    await aimGraph({ databaseId: db, queryId: null, script: manifest.start ?? null }, { reset: true }).catch(() => {});
    onOpen("graph");
  };

  const trouble = error && html`<div className="label mysteries-error">${error}</div>`;
  const plate = (inner) => html`<div className="panel"><${Ornament} className="ornament--fill">${inner}<//></div>`;

  if (!ready || list === null) return plate(trouble ?? html`<div className="label">Loading…</div>`);
  if (loading) return plate(html`<div className="label">Loading the case</div>`);

  if (!manifest) {
    return plate(html`
      ${trouble}
      <div className="label ledger-head">Cases</div>
      <div className="tiles">
        ${list.map((m, i) => html`<button className="tile" key=${m.id} onClick=${() => open(m)}>
          <span className="tile-art" aria-hidden="true">${count(i + 1)}</span>
          <span className="tile-title">${m.title}</span>
          <span className="tile-blurb">${m.blurb}</span>
          <span className="tile-meta">
            <span className="label">${m.difficulty}</span>
            <span className="label">${count(m.questions.length)} questions</span>
          </span>
        </button>`)}
      </div>`);
  }

  const total = manifest.questions.length;
  const solved = saved.step >= total;

  return plate(html`<div className="case">
    <div className="case-story">
      <div className="label case-kicker">Case ${count(list.indexOf(manifest) + 1)}</div>
      <h2 className="case-title">${manifest.title}</h2>
      ${trouble}
      ${missing && html`<div className="label mysteries-error">This case's database is no longer on the Ingestor. Load the dump again to continue.</div>`}
      <p className="case-brief">${solved ? manifest.epilogue : manifest.brief}</p>
      <div className="figures">
        <${Figure} label="Difficulty" value=${capital(manifest.difficulty)} />
        <${Figure} label="Answered" value=${`${count(Math.min(saved.step, total))} of ${count(total)}`} />
        <${Figure} label="Hints opened" value=${count(saved.hints.length)} />
        <${Figure} label="Snapshot" value=${snapshot(manifest)} />
      </div>
      <div className="case-actions">
        ${missing
          ? html`<${Button} text="Load the dump again" onClick=${() => open(manifest)} />`
          : html`<${Button} text="Investigate on the Graph" onClick=${investigate} />`}
        <${Button} text=${solved ? "Close the case" : "Abandon the case"}
          onClick=${() => (solved || saved.step === 0 ? save(CLOSED) : setAbandoning(true))} />
      </div>
    </div>

    <${ConfirmDialog} isOpen=${abandoning} title="Abandon the case" confirm="Abandon"
      subject=${manifest.title}
      detail=${`Your ${count(saved.step)} answered ${saved.step === 1 ? "question" : "questions"} and opened hints are cleared. The case's database stays in the Ingestor.`}
      onConfirm=${() => { setAbandoning(false); save(CLOSED); }} onClose=${() => setAbandoning(false)} />

    <div className="case-inquiry">
      <div className="label ledger-head">${solved ? "Case closed" : "The inquiry"}</div>
      ${manifest.questions.map((q, i) => i < saved.step
        ? html`<div className="inquiry-line" key=${i}>
            <div className="inquiry-ask">
              <span className="inquiry-index">${i + 1}</span>
              <span className="inquiry-question">${q.ask}</span>
              <span className="mono inquiry-answer">${saved.answers[i] ?? ""}</span>
            </div>
          </div>`
        : i === saved.step
          ? html`<${Question} key=${i} index=${i} question=${q} hints=${saved.hints}
              onHint=${(key) => save({ hints: [...saved.hints, key] })}
              onRight=${(text) => save({ step: saved.step + 1, answers: [...saved.answers, text] })} />`
          : html`<div className="inquiry-line inquiry-line--locked" key=${i}>
              <div className="inquiry-ask"><span className="inquiry-index">${i + 1}</span><span className="inquiry-question">Answer the previous question to unlock this one.</span></div>
            </div>`)}
    </div>
  </div>`);
}

const MOTIF = html`
  <circle cx="48" cy="8" r="36" stroke="currentColor" stroke-width="1.6" fill="none"></circle>
  <circle cx="48" cy="8" r="31" stroke="currentColor" stroke-width="0.8" fill="none"></circle>
  <path d="M74 33L86 45" stroke="currentColor" stroke-width="2" fill="none"></path>
  <path d="M86 45L150 109" stroke="currentColor" stroke-width="9" fill="none"></path>`;

export default defineModule({
  id: "mysteries",
  title: "Mysteries",
  motif: MOTIF,
  Panel: MysteriesPanel,
  styles: [new URL("./mysteries.css", import.meta.url)],
  enabled: (session) => Boolean(session.challenges),
});

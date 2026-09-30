import { count, bytes, NA } from "../../core/index.js";
import { html, useState, Button, Popover, dropdown, Menu, MenuItem, MenuDivider, mark, PageSection, KeyValue } from "../../ui/index.js";
import { Status, settling, ingestedAt } from "./databaseTable.js";

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

const FILE_STATUS = { short: "Incomplete", ignored: "Not recognised", rejected: "Rejected" };

function Actions({ db, busy, onAnalyse, onUpload, onDelete }) {
  const [open, setOpen] = useState(false);
  const run = (fn) => () => { setOpen(false); fn(); };
  return html`<${Popover} ...${dropdown} placement="bottom-end" isOpen=${open}
    onInteraction=${(next) => setOpen(next)}
    content=${html`<${Menu}>
      <${MenuItem} text="Upload files into this database" disabled=${busy} onClick=${run(onUpload)} />
      <${MenuItem} text="Re-run analysis" disabled=${busy} onClick=${run(onAnalyse)}
        htmlTitle="Runs this build's passes over the data again; an upload is analysed without it" />
      <${MenuDivider} />
      <${MenuItem} text="Delete database…" intent="danger" disabled=${busy} onClick=${run(onDelete)} />
    <//>`}>
    <${Button} small text="Actions" rightIcon=${mark(open ? "chevron-up" : "chevron-down")} active=${open}
      aria-label=${`Actions for ${db.name}`} />
  <//>`;
}

function Summary({ db, census, sources, busy, actions, onAnalyse }) {
  const at = ingestedAt(db);
  return html`<${PageSection} title=${db.name} className="ing-summary" tools=${actions}>
    ${ ""}
    ${db.analysisError && !busy && html`<div className="ing-callout" role="alert">
      <p>The last analysis did not finish, so Tier Zero, routes and findings are not what this
        data holds: ${db.analysisError}</p>
      <${Button} small text="Try again" onClick=${onAnalyse} />
    </div>`}
    <${KeyValue} label="Status" value=${html`<${Status} db=${db} busy=${busy} />`} />
    <${KeyValue} label="Ingested" value=${at?.full ?? NA} />
    <${KeyValue} label="Objects" value=${count(db.nodeCount)}
      sub=${db.baseCount > 0 ? `${count(db.baseCount)} unresolved` : null} />
    <${KeyValue} label="Relationships" value=${count(db.edgeCount)}
      sub=${db.derivedEdgeCount > 0 ? `${count(db.derivedEdgeCount)} derived` : null} />
    <${KeyValue} label="Tier Zero" value=${db.analyzed ? count(db.tierZeroCount) : NA}
      sub=${settling(db) ? "being computed" : null} />
    <${KeyValue} label="Sessions collected"
      value=${census?.computersEnabled > 0
        ? `${count(census.computersWithSessions)} of ${count(census.computersEnabled)} hosts` : NA}
      flag=${census?.computersEnabled > 0 && census.computersWithSessions / census.computersEnabled < 0.5} />
    ${sources.length > 0 && html`<${KeyValue} label="Merged from" value=${sources.join(" + ")}
      title=${sources.join(" + ")} />`}
  <//>`;
}

function Files({ db, detail, error }) {
  return html`<${PageSection} title="Files" count=${count(db.fileCount)} className="ing-files">
    ${error && html`<p className="ing-empty-note is-fault">${error}</p>`}
    ${!error && !detail && html`<p className="ing-empty-note">Reading the ledger…</p>`}
    ${detail && detail.files.length === 0 && html`<p className="ing-empty-note">${db.sources.length > 0
      ? "A merge reads no files: each file is listed in the database it was uploaded to."
      : "No files recorded."}</p>`}
    ${detail?.files.map((file) => {
      const fault = FILE_STATUS[file.status];
      return html`<div key=${file.name} className="ing-file">
        <${KeyValue} title=${file.name}
          label=${html`<span className="row-t mono ing-file-name">${file.name}</span>`}
          value=${fault ?? plural(file.nodes ?? 0, "object")} flag=${Boolean(fault)}
          sub=${bytes(file.bytes)} />
        ${file.note && html`<div className=${"ing-file-note" + (fault ? " is-fault" : "")}>${file.note}</div>`}
      </div>`;
    })}
  <//>`;
}

export function Inspector({ db, detail, detailError, databases, busy, analysing, onAnalyse, onUpload, onDelete }) {
  const names = new Map(databases.map((d) => [d.id, d.name]));
  const sources = db.sources.map((id) => names.get(id) ?? "a deleted database");
  const actions = html`<${Actions} db=${db} busy=${busy}
    onAnalyse=${onAnalyse} onUpload=${onUpload} onDelete=${onDelete} />`;
  return html`<div className="ing-side">
    <${Summary} db=${db} census=${detail?.census} sources=${sources} busy=${analysing} actions=${actions}
      onAnalyse=${onAnalyse} />
    <${Files} db=${db} detail=${detail} error=${detailError} />
  </div>`;
}

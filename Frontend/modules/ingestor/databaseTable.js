import { count, NA, utcMinute } from "../../core/index.js";
import { html, Table, StatusTag } from "../../ui/index.js";

export const ingestedAt = (db) => {
  const at = new Date(db.created);
  return Number.isFinite(at.getTime()) ? { day: db.created.slice(0, 10), full: utcMinute(at) } : null;
};

export const settling = (db) => !db.analyzed && !db.analysisError;

export const Status = ({ db, busy }) => !busy && db.analysisError
  ? html`<${StatusTag} tone="fault" title=${db.analysisError}>Failed<//>`
  : busy || settling(db)
    ? html`<${StatusTag} tone="busy"
        title=${busy ? null : "Being analysed; this settles on its own"}>Analysing<//>`
    : html`<${StatusTag} tone="ok">Ready<//>`;

const COLUMNS = [
  { label: "Name", width: 23 },
  { label: "Domains", width: 22 },
  { label: "Files", width: 7, align: "right" },
  { label: "Objects", width: 11, align: "right" },
  { label: "Tier Zero", width: 10, align: "right" },
  { label: "Ingested", width: 13, align: "right" },
  { label: "Status", width: 14 },
];

export function DatabaseTable({ databases, selected, busyId, offers = new Map(), onSelect }) {
  const move = (e, index) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      e.preventDefault();
      const next = databases[Math.min(databases.length - 1, Math.max(0, index + step))];
      onSelect(next.id);
      e.currentTarget.parentElement?.children[databases.indexOf(next)]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(databases[index].id);
    }
  };

  return html`<${Table} id="ingest-databases" interactive flush columns=${COLUMNS}>
    <tbody>
      ${databases.map((db, index) => {
        const on = db.id === selected;
        const domains = db.domains.map((d) => d.label).join(", ");
        const at = ingestedAt(db);
        return html`<tr key=${db.id} tabIndex=${on ? 0 : -1} aria-selected=${on}
          className=${on ? "lae-selected" : ""}
          onClick=${() => onSelect(db.id)} onKeyDown=${(e) => move(e, index)}>
          <td title=${db.name}><span className="ing-name">
            <span className="ing-name-text">${db.name}</span>
            ${offers.has(db.id) && html`<span className="ing-offer"
              title=${`A merge with ${offers.get(db.id).join(", ")} is suggested`}>Merge</span>`}
          </span></td>
          <td className="ing-cell-quiet" title=${domains}>${domains || NA}</td>
          <td className="lae-num">${count(db.fileCount)}</td>
          <td className="lae-num">${count(db.nodeCount)}</td>
          <td className="lae-num">${db.analyzed ? count(db.tierZeroCount) : NA}</td>
          <td className="lae-num" title=${at?.full}>${at?.day ?? NA}</td>
          <td><${Status} db=${db} busy=${busyId === db.id} /></td>
        </tr>`;
      })}
    </tbody>
  <//>`;
}

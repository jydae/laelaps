import { html, defineModule } from "../../core/index.js";
import { IngestorPanel } from "./ingestorPanel.js";

export { ingestBatch } from "./upload.js";

const MOTIF = html`
    ${[16, 36, 56].map(cy => html`<ellipse key=${cy} cx="128" cy=${cy} rx="58" ry="12" stroke="currentColor" stroke-width="1.6" fill="none"></ellipse>`)}
    <path d="M70 16V80M186 16V80" stroke="currentColor" stroke-width="1.6" fill="none"></path>`;

export default defineModule({
  id: "ingestor",
  title: "Ingestor",
  motif: MOTIF,
  Panel: IngestorPanel,
  styles: [new URL("./ingestor.css", import.meta.url)],
});

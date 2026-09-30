import { html, createRoot, iconsReady } from "./ui/index.js";
import { loadModuleStyles } from "./core/index.js";
import { App } from "./shell/shell.js";
import statistics from "./modules/statistics/index.js";
import graph from "./modules/graph/index.js";
import ingestor from "./modules/ingestor/index.js";
import mysteries from "./modules/mysteries/index.js";

const modules = [statistics, graph, ingestor, mysteries];

await Promise.all([loadModuleStyles(modules), iconsReady]);
createRoot(document.getElementById("root")).render(html`<${App} modules=${modules} />`);

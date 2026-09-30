import { count, uploadFile, analyzeDatabase, databasesChanged } from "../../core/index.js";
import { isArchive, readZip } from "./zip.js";

export const ACCEPT = ".json,.zip";

const isDump = (name) => /\.json$/i.test(name);

export const newDatabaseId = () =>
  `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

async function expand(dropped, skipped, onProgress) {
  const queue = [];
  let archives = 0;
  for (const file of dropped) {
    if (!isArchive(file)) {
      queue.push({ name: file.name, size: file.size, read: async () => file });
      continue;
    }
    archives += 1;
    onProgress({ phase: "unpack", done: 0, total: dropped.length, name: file.name });
    try {
      const opened = await readZip(file);
      queue.push(...opened.members);
      skipped.push(...opened.skipped);
    } catch (e) {
      skipped.push({ name: file.name, reason: e.message });
    }
  }
  return { queue, archives };
}

export async function ingestBatch(fileList, { into = null, name = null, onProgress = () => {} } = {}) {
  const dropped = Array.from(fileList ?? []);
  if (dropped.length === 0) return null;
  const dbId = into ?? newDatabaseId();

  const skipped = [];
  const { queue } = await expand(dropped, skipped, onProgress);

  let files = 0, objects = 0, remarks = 0, failed = 0;
  for (const [i, member] of queue.entries()) {
    onProgress({ phase: "upload", done: i, total: queue.length, name: member.name });
    if (!isDump(member.name)) {
      skipped.push({ name: member.name, reason: "not SharpHound output (a .json dump or a collector .zip)" });
      continue;
    }
    try {
      const r = await uploadFile(dbId, await member.read(), name);
      if (r?.status === "ignored") {
        skipped.push({ name: member.name, reason: r.note ?? "not a BloodHound dump" });
      } else {
        files += 1;
        objects += r?.nodesIndexed ?? 0;
        if (r?.note) remarks += 1;
      }
    } catch (e) {
      failed += 1;
      skipped.push({ name: member.name, reason: e.message });
    }
  }

  const parts = [`Ingested ${plural(files, "file")} (${plural(objects, "object")})`];
  const fault = failed > 0;
  if (files > 0) {
    onProgress({ phase: "analyse", done: queue.length, total: queue.length, name: "Analysing" });
    try {
      const a = await analyzeDatabase(dbId);
      parts.push(`${count(a.tierZeroCount)} Tier Zero objects${a.tierZeroSettled === false ? " (a lower bound)" : ""}`);
    } catch (e) {

      parts.push(`the analysis did not answer here (${e.message})`);
    }
    databasesChanged();
  }
  if (remarks > 0) parts.push(`${plural(remarks, "file")} with remarks`);
  if (skipped.length > 0) parts.push(`${count(skipped.length)} skipped`);

  return {
    note: `${parts.join(", ")}.`,
    fault: fault || files === 0,
    db: files > 0 ? dbId : into,
    skipped,
    files,
    objects,
  };
}

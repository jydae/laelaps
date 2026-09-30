const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const LOCATOR64_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;

const STORED = 0;
const DEFLATE = 8;

const TAIL_BYTES = 64 * 1024 + 22;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const utf8 = new TextDecoder("utf-8");

export const isArchive = (file) => /\.zip$/i.test(file.name || "");

const inflatable = () => {
  try { return !!new DecompressionStream("deflate-raw"); } catch { return false; }
};

async function view(blob) {
  return new DataView(await blob.arrayBuffer());
}

function u64(data, at) {
  const value = data.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Archive uses 64-bit offsets beyond what a browser can address.");
  }
  return Number(value);
}

async function directory(file) {
  const from = Math.max(0, file.size - TAIL_BYTES);
  const tail = await view(file.slice(from));

  let eocd = -1;
  for (let at = tail.byteLength - 22; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) === EOCD_SIG) { eocd = at; break; }
  }
  if (eocd < 0) {
    throw new Error("Not a zip, or the archive is truncated (no end-of-directory record).");
  }

  let entries = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);

  const saturated = entries === U16_MAX || size === U32_MAX || offset === U32_MAX;
  if (saturated && eocd >= 20 && tail.getUint32(eocd - 20, true) === LOCATOR64_SIG) {
    const at = u64(tail, eocd - 20 + 8);
    const record = await view(file.slice(at, at + 56));
    if (record.byteLength >= 56 && record.getUint32(0, true) === EOCD64_SIG) {
      entries = u64(record, 32);
      size = u64(record, 40);
      offset = u64(record, 48);
    }
  }
  return { entries, bytes: await view(file.slice(offset, offset + size)) };
}

function zip64Extra(data, at, length, entry) {
  let cursor = at;
  const end = at + length;
  while (cursor + 4 <= end) {
    const id = data.getUint16(cursor, true);
    const size = data.getUint16(cursor + 2, true);
    let field = cursor + 4;
    if (id === 0x0001) {
      if (entry.size === U32_MAX && field + 8 <= end) { entry.size = u64(data, field); field += 8; }
      if (entry.packed === U32_MAX && field + 8 <= end) { entry.packed = u64(data, field); field += 8; }
      if (entry.at === U32_MAX && field + 8 <= end) entry.at = u64(data, field);
      return;
    }
    cursor = field + size;
  }
}

const isResourceFork = (name) =>
  name.startsWith("__MACOSX/") || /(^|\/)\._/.test(name);

export async function readZip(file) {
  const { entries, bytes } = await directory(file);
  const members = [];
  const skipped = [];
  const canInflate = inflatable();

  let at = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > bytes.byteLength || bytes.getUint32(at, true) !== CENTRAL_SIG) break;

    const flags = bytes.getUint16(at + 8, true);
    const method = bytes.getUint16(at + 10, true);
    const nameLength = bytes.getUint16(at + 28, true);
    const extraLength = bytes.getUint16(at + 30, true);
    const commentLength = bytes.getUint16(at + 32, true);
    const entry = {
      packed: bytes.getUint32(at + 20, true),
      size: bytes.getUint32(at + 24, true),
      at: bytes.getUint32(at + 42, true),
    };
    const name = utf8.decode(
      new Uint8Array(bytes.buffer, bytes.byteOffset + at + 46, nameLength));
    zip64Extra(bytes, at + 46 + nameLength, extraLength, entry);
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || isResourceFork(name)) continue;

    if (flags & 1) { skipped.push({ name, reason: "encrypted" }); continue; }
    if (method !== STORED && method !== DEFLATE) {
      skipped.push({ name, reason: `unsupported compression (method ${method})` });
      continue;
    }
    if (method === DEFLATE && !canInflate) {
      skipped.push({ name, reason: "this browser cannot inflate deflate-raw streams" });
      continue;
    }
    if (/\.zip$/i.test(name)) {

      skipped.push({ name, reason: "nested archive: unzip it and upload the files inside" });
      continue;
    }

    members.push({
      name,
      size: entry.size,
      read: () => inflate(file, name, entry, method),
    });
  }
  return { members, skipped };
}

async function inflate(file, name, entry, method) {
  const header = await view(file.slice(entry.at, entry.at + 30));
  const start = entry.at + 30
    + header.getUint16(26, true)
    + header.getUint16(28, true);
  const packed = file.slice(start, start + entry.packed);

  const blob = method === STORED
    ? packed
    : await new Response(packed.stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .pipeThrough(atMost(entry.size, name))).blob();

  if (blob.size !== entry.size) {
    throw new Error(
      `${name} inflated to ${blob.size} bytes, not the ${entry.size} the archive declares.`);
  }
  return new File([blob], name);
}

const atMost = (limit, name) => {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`${name} inflates past the ${limit} bytes the archive declares.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

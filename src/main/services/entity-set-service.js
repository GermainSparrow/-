const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { AppError } = require("./app-error");
const defaultEntitySets = require("../data/default-entity-sets.json");

const STORE_FILE_NAME = "entity-sets.json";
const GENERIC_ENTITY_TYPE = "entity";
let storeDirectory = null;
let memoryEntitySets = null;

function configureEntitySetStore(directory) {
  storeDirectory = directory;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function stableId(prefix, value) {
  return `${prefix}-${sha256(value).slice(0, 12)}`;
}

function isBlankEntitySetItem(item) {
  return (
    !String(item?.canonicalName || "").trim() &&
    !uniqueStrings(item?.aliases).length &&
    !String(item?.maskedValue || "").trim() &&
    !String(item?.sourceName || "").trim() &&
    !String(item?.sourceUrl || "").trim() &&
    !String(item?.notes || "").trim()
  );
}

function normalizeEntitySetItem(item, setId, index) {
  const canonicalName = String(item?.canonicalName || "").trim();
  if (!canonicalName) {
    throw new AppError("INVALID_ENTITY_SET", "实体集条目必须包含实体名称");
  }

  return {
    id: String(item?.id || stableId("item", `${setId}:${canonicalName}:${index}`)),
    type: GENERIC_ENTITY_TYPE,
    canonicalName,
    aliases: uniqueStrings(item?.aliases).filter((alias) => alias !== canonicalName),
    maskedValue: String(item?.maskedValue || "").trim(),
    enabled: item?.enabled !== false,
    sourceName: String(item?.sourceName || "").trim(),
    sourceUrl: String(item?.sourceUrl || "").trim(),
    notes: String(item?.notes || "").trim()
  };
}

function normalizeEntitySet(entitySet, index = 0) {
  const name = String(entitySet?.name || "").trim();
  if (!name) {
    throw new AppError("INVALID_ENTITY_SET", "实体集必须包含名称");
  }

  const id = String(entitySet?.id || stableId("entity-set", `${name}:${index}`));
  const items = (entitySet?.items || [])
    .filter((item) => !isBlankEntitySetItem(item))
    .map((item, itemIndex) => normalizeEntitySetItem(item, id, itemIndex));

  return {
    id,
    name,
    enabled: entitySet?.enabled !== false,
    version: String(entitySet?.version || "1.0.0").trim(),
    updatedAt: String(entitySet?.updatedAt || new Date().toISOString()),
    items
  };
}

function normalizeEntitySets(entitySets) {
  if (!Array.isArray(entitySets)) {
    throw new AppError("INVALID_ENTITY_SET", "实体集数据必须是数组");
  }

  const seenSetIds = new Set();
  return entitySets.map((entitySet, index) => {
    const normalized = normalizeEntitySet(entitySet, index);
    if (seenSetIds.has(normalized.id)) {
      normalized.id = stableId("entity-set", `${normalized.name}:${index}:${normalized.updatedAt}`);
    }
    seenSetIds.add(normalized.id);
    return normalized;
  });
}

function defaultSets() {
  return normalizeEntitySets(clone(defaultEntitySets));
}

function compareVersion(left, right) {
  const leftParts = String(left || "").split(".").map((part) => Number(part) || 0);
  const rightParts = String(right || "").split(".").map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function mergeDefaultBuiltinUpdates(entitySets) {
  const builtinDefaultsById = new Map(
    defaultSets()
      .filter((entitySet) => entitySet.id.startsWith("builtin-"))
      .map((entitySet) => [entitySet.id, entitySet])
  );

  return entitySets.map((entitySet) => {
    const defaultEntitySet = builtinDefaultsById.get(entitySet.id);
    if (!defaultEntitySet) return entitySet;
    if (compareVersion(entitySet.version, defaultEntitySet.version) >= 0) return entitySet;

    const defaultItemsById = new Map(defaultEntitySet.items.map((item) => [item.id, item]));
    let changed = false;
    const items = entitySet.items.map((item) => {
      const defaultItem = defaultItemsById.get(item.id);
      if (!defaultItem) return item;

      const aliases = uniqueStrings([...(item.aliases || []), ...(defaultItem.aliases || [])])
        .filter((alias) => alias !== item.canonicalName);
      const currentAliases = item.aliases || [];
      const aliasesChanged = aliases.length !== currentAliases.length ||
        aliases.some((alias, index) => alias !== currentAliases[index]);
      if (!aliasesChanged) return item;

      changed = true;
      return {
        ...item,
        aliases
      };
    });

    if (!changed) return entitySet;
    return {
      ...entitySet,
      version: defaultEntitySet.version,
      updatedAt: defaultEntitySet.updatedAt,
      items
    };
  });
}

function storeFilePath() {
  if (!storeDirectory) return null;
  return path.join(storeDirectory, STORE_FILE_NAME);
}

async function ensureStoreFile() {
  const filePath = storeFilePath();
  if (!filePath) {
    if (!memoryEntitySets) {
      memoryEntitySets = defaultSets();
    }
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultSets(), null, 2), "utf8");
  }
}

async function readEntitySets() {
  await ensureStoreFile();
  const filePath = storeFilePath();
  if (!filePath) {
    return mergeDefaultBuiltinUpdates(clone(memoryEntitySets));
  }

  try {
    return mergeDefaultBuiltinUpdates(normalizeEntitySets(JSON.parse(await fs.readFile(filePath, "utf8"))));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("ENTITY_SET_READ_FAILED", "无法读取本地实体集配置", error.message);
  }
}

async function writeEntitySets(entitySets) {
  const normalized = normalizeEntitySets(entitySets);
  const filePath = storeFilePath();
  if (!filePath) {
    memoryEntitySets = normalized;
    return clone(normalized);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return clone(normalized);
}

async function listEntitySets() {
  return readEntitySets();
}

async function saveEntitySet(entitySet) {
  const current = await readEntitySets();
  const normalized = normalizeEntitySet({
    ...entitySet,
    updatedAt: new Date().toISOString()
  });
  const index = current.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    current[index] = normalized;
  } else {
    current.push(normalized);
  }
  await writeEntitySets(current);
  return normalized;
}

async function deleteEntitySet(id) {
  const current = await readEntitySets();
  const next = current.filter((entitySet) => entitySet.id !== id);
  await writeEntitySets(next);
  return next;
}

function parseJsonEntitySets(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new AppError("INVALID_ENTITY_SET_IMPORT", "JSON 实体集格式无效", error.message);
  }

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.sets)) return parsed.sets;
  if (parsed?.name && Array.isArray(parsed?.items)) return [parsed];
  throw new AppError("INVALID_ENTITY_SET_IMPORT", "JSON 实体集必须是实体集、实体集数组或 { sets } 对象");
}

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseCsvEntitySet(content) {
  const rows = parseCsvRows(content);
  if (!rows.length) {
    throw new AppError("INVALID_ENTITY_SET_IMPORT", "CSV 实体集为空");
  }

  const headers = rows[0].map((header) => header.trim());
  const indexOf = (name) => headers.indexOf(name);
  const canonicalIndex = indexOf("canonicalName");
  if (canonicalIndex < 0) {
    throw new AppError("INVALID_ENTITY_SET_IMPORT", "CSV 必须包含 canonicalName 列");
  }

  const items = rows.slice(1)
    .map((row) => ({
      type: GENERIC_ENTITY_TYPE,
      canonicalName: row[canonicalIndex],
      aliases: (row[indexOf("aliases")] || "").split("|"),
      maskedValue: row[indexOf("maskedValue")] || "",
      enabled: (row[indexOf("enabled")] || "true").trim().toLowerCase() !== "false",
      sourceName: row[indexOf("sourceName")] || "",
      sourceUrl: row[indexOf("sourceUrl")] || "",
      notes: row[indexOf("notes")] || ""
    }))
    .filter((item) => String(item.canonicalName || "").trim());

  return [{
    id: stableId("imported", `csv:${Date.now()}`),
    name: "导入实体集",
    enabled: true,
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    items
  }];
}

async function importEntitySet({ format, content }) {
  const entitySets = format === "csv"
    ? parseCsvEntitySet(content)
    : parseJsonEntitySets(content);
  const imported = normalizeEntitySets(entitySets).map((entitySet, index) => ({
    ...entitySet,
    id: entitySet.id && !entitySet.id.startsWith("builtin-")
      ? entitySet.id
      : stableId("imported", `${entitySet.name}:${Date.now()}:${index}`),
    updatedAt: new Date().toISOString()
  }));
  const current = await readEntitySets();
  const byId = new Map(current.map((entitySet) => [entitySet.id, entitySet]));
  for (const entitySet of imported) {
    byId.set(entitySet.id, entitySet);
  }
  await writeEntitySets(Array.from(byId.values()));
  return imported;
}

function csvEscape(value) {
  const text = String(value || "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toCsv(entitySet) {
  const headers = ["canonicalName", "aliases", "maskedValue", "enabled", "sourceName", "sourceUrl", "notes"];
  const rows = entitySet.items.map((item) => [
    item.canonicalName,
    item.aliases.join("|"),
    item.maskedValue,
    item.enabled,
    item.sourceName,
    item.sourceUrl,
    item.notes
  ]);
  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

async function exportEntitySet({ id, format }) {
  const entitySets = await readEntitySets();
  const entitySet = entitySets.find((item) => item.id === id);
  if (!entitySet) {
    throw new AppError("ENTITY_SET_NOT_FOUND", "未找到实体集");
  }

  const safeName = entitySet.name.replace(/[\\/:*?"<>|]/g, "_");
  return {
    fileName: `${safeName}.${format}`,
    content: format === "csv" ? toCsv(entitySet) : JSON.stringify(entitySet, null, 2)
  };
}

function clearEntitySetStoreForTest() {
  memoryEntitySets = null;
  storeDirectory = null;
}

module.exports = {
  clearEntitySetStoreForTest,
  configureEntitySetStore,
  exportEntitySet,
  importEntitySet,
  listEntitySets,
  saveEntitySet,
  deleteEntitySet
};

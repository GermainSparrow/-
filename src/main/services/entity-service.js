const crypto = require("node:crypto");

const GENERIC_ENTITY_TYPE = "entity";

const TYPE_PREFIX = {
  entity: "ENTITY",
  company: "ORG",
  person: "PERSON",
  phone: "PHONE",
  idCard: "ID",
  address: "ADDR",
  email: "EMAIL",
  account: "ACCOUNT"
};

const TYPE_LABEL = {
  entity: "实体",
  company: "公司",
  person: "人名",
  phone: "手机号",
  idCard: "身份证",
  address: "地址",
  email: "邮箱",
  account: "账号"
};

const DETECTORS = [
  {
    type: "idCard",
    pattern: /(?<![0-9Xx])\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9Xx])/g
  },
  {
    type: "phone",
    pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g
  },
  {
    type: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
  },
  {
    type: "account",
    pattern: /(?<!\d)\d{16,19}(?!\d)/g
  }
];

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function createDocId(filePath, stat, contentHash) {
  return sha256(`${filePath}:${stat.size}:${contentHash}`).slice(0, 16);
}

function makeStableId(type, index) {
  const prefix = TYPE_PREFIX[type || GENERIC_ENTITY_TYPE] || TYPE_PREFIX[GENERIC_ENTITY_TYPE];
  return `${prefix}_${String(index).padStart(3, "0")}`;
}

function defaultMaskedValue(stableId) {
  return `<${stableId}>`;
}

function contextHash(text, index, length) {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return sha256(text.slice(start, end)).slice(0, 16);
}

function addEntitySeed(byDocAndValue, document, segment, originalValue, index, source, maskedValue = "") {
  const key = `${document.docId}:${originalValue}`;
  const existing = byDocAndValue.get(key) || {
    docId: document.docId,
    filePath: document.path,
    type: GENERIC_ENTITY_TYPE,
    originalValue,
    firstIndex: index,
    contextHash: contextHash(segment.text, index, originalValue.length),
    locations: [],
    source,
    maskedValue,
    enabled: true
  };

  existing.firstIndex = Math.min(existing.firstIndex, index);
  existing.locations.push({
    segmentId: segment.id,
    index,
    length: originalValue.length
  });
  byDocAndValue.set(key, existing);
}

function detectRuleEntities(documents, byDocAndValue) {
  for (const document of documents) {
    for (const segment of document.textSegments) {
      for (const detector of DETECTORS) {
        detector.pattern.lastIndex = 0;
        let match;
        while ((match = detector.pattern.exec(segment.text)) !== null) {
          addEntitySeed(byDocAndValue, document, segment, match[0], match.index, "auto");
        }
      }
    }
  }
}

function collectCustomTerms(entitySets = []) {
  const terms = [];
  const seen = new Set();

  for (const entitySet of entitySets) {
    if (entitySet?.enabled === false) continue;
    for (const item of entitySet?.items || []) {
      if (item?.enabled === false) continue;
      const values = [item.canonicalName, ...(item.aliases || [])]
        .map((value) => String(value || "").trim())
        .filter((value) => value.length >= 2);

      for (const value of values) {
        const key = value;
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push({
          value,
          maskedValue: String(item.maskedValue || "").trim(),
          order: terms.length
        });
      }
    }
  }

  return terms.sort((left, right) => {
    if (right.value.length !== left.value.length) return right.value.length - left.value.length;
    return left.order - right.order;
  });
}

function overlaps(existingRanges, start, end) {
  return existingRanges.some((range) => start < range.end && end > range.start);
}

function detectCustomEntities(documents, entitySets, byDocAndValue) {
  const terms = collectCustomTerms(entitySets);
  if (!terms.length) return;

  for (const document of documents) {
    for (const segment of document.textSegments) {
      const occupiedRanges = [];
      for (const term of terms) {
        let index = segment.text.indexOf(term.value);
        while (index !== -1) {
          const end = index + term.value.length;
          if (!overlaps(occupiedRanges, index, end)) {
            occupiedRanges.push({ start: index, end });
            addEntitySeed(byDocAndValue, document, segment, term.value, index, "custom", term.maskedValue);
          }
          index = segment.text.indexOf(term.value, index + term.value.length);
        }
      }
    }
  }
}

function detectEntities(documents, entitySets = []) {
  const byDocAndValue = new Map();
  detectRuleEntities(documents, byDocAndValue);
  detectCustomEntities(documents, entitySets, byDocAndValue);

  const grouped = Array.from(byDocAndValue.values()).sort((left, right) => {
    if (left.docId !== right.docId) return left.docId.localeCompare(right.docId);
    return left.firstIndex - right.firstIndex;
  });

  const counters = new Map();
  return grouped.map((entity) => {
    const counterKey = entity.docId;
    const nextIndex = (counters.get(counterKey) || 0) + 1;
    counters.set(counterKey, nextIndex);
    const stableId = makeStableId(GENERIC_ENTITY_TYPE, nextIndex);

    return {
      id: sha256(`${entity.docId}:${entity.originalValue}`).slice(0, 16),
      docId: entity.docId,
      filePath: entity.filePath,
      type: GENERIC_ENTITY_TYPE,
      originalValue: entity.originalValue,
      maskedValue: entity.maskedValue || defaultMaskedValue(stableId),
      stableId,
      contextHash: entity.contextHash,
      locations: entity.locations,
      enabled: true,
      source: entity.source
    };
  });
}

function detectStructuredValues(text) {
  const byTypeAndValue = new Map();
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    let match;
    while ((match = detector.pattern.exec(text)) !== null) {
      const originalValue = match[0];
      const key = `${detector.type}:${originalValue}`;
      if (!byTypeAndValue.has(key)) {
        byTypeAndValue.set(key, {
          type: detector.type,
          originalValue
        });
      }
    }
  }
  return Array.from(byTypeAndValue.values());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function activeEntities(entities) {
  return entities
    .filter((entity) => entity.enabled !== false && entity.originalValue && entity.maskedValue)
    .sort((left, right) => right.originalValue.length - left.originalValue.length);
}

function applySanitization(text, entities) {
  let result = text;
  for (const entity of activeEntities(entities)) {
    result = result.replace(new RegExp(escapeRegExp(entity.originalValue), "g"), entity.maskedValue);
  }
  return result;
}

function applyRestoration(text, entities) {
  let result = text;
  const sorted = entities
    .filter((entity) => entity.enabled !== false && entity.originalValue)
    .sort((left, right) => {
      const leftLength = Math.max(left.maskedValue.length, left.stableId.length + 2);
      const rightLength = Math.max(right.maskedValue.length, right.stableId.length + 2);
      return rightLength - leftLength;
    });

  for (const entity of sorted) {
    if (entity.maskedValue) {
      result = result.replace(new RegExp(escapeRegExp(entity.maskedValue), "g"), entity.originalValue);
    }
    if (entity.stableId) {
      result = result.replace(new RegExp(escapeRegExp(`<${entity.stableId}>`), "g"), entity.originalValue);
    }
  }

  return result;
}

function findOriginalLeaks(text, entities) {
  const leaks = [];
  for (const entity of activeEntities(entities)) {
    if (text.includes(entity.originalValue)) {
      leaks.push({
        type: entity.type || GENERIC_ENTITY_TYPE,
        stableId: entity.stableId
      });
    }
  }
  return leaks;
}

function summarizeEntities(entities) {
  return entities.reduce((summary, entity) => {
    if (entity.enabled === false) return summary;
    summary.total += 1;
    const type = entity.type || GENERIC_ENTITY_TYPE;
    const source = entity.source || "auto";
    summary.byType[type] = (summary.byType[type] || 0) + 1;
    summary.bySource[source] = (summary.bySource[source] || 0) + 1;
    return summary;
  }, { total: 0, byType: {}, bySource: {} });
}

module.exports = {
  GENERIC_ENTITY_TYPE,
  TYPE_LABEL,
  applyRestoration,
  applySanitization,
  createDocId,
  detectEntities,
  detectStructuredValues,
  findOriginalLeaks,
  makeStableId,
  summarizeEntities
};

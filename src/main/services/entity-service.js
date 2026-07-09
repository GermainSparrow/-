const crypto = require("node:crypto");
const {
  COMMON_CHINESE_SURNAMES,
  COMMON_COMPOUND_SURNAMES,
  defaultMaskedValue,
  isLikelyPersonName
} = require("../../shared/person-masking");

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

const PERSON_LABELS = [
  "项目负责人",
  "法定代表人",
  "委托代理人",
  "负责人",
  "联系人",
  "经办人",
  "承办人",
  "办理人",
  "审核人",
  "复核人",
  "审批人",
  "批准人",
  "编制人",
  "校核人",
  "项目经理",
  "代理人",
  "申请人",
  "被申请人",
  "签字人",
  "签收人",
  "收件人",
  "发件人",
  "姓名",
  "作者"
].sort((left, right) => right.length - left.length);

const CHINESE_PERSON_NAME_PATTERN = `(?:${COMMON_COMPOUND_SURNAMES.join("|")}|[${COMMON_CHINESE_SURNAMES}])[\\u4e00-\\u9fff·]{1,3}`;
const PERSON_TITLE_LABELS = [
  "党委副书记",
  "党委书记",
  "党委委员",
  "纪委书记",
  "法定代表人",
  "执行董事",
  "副董事长",
  "董事长",
  "副总经理",
  "总经理",
  "总工程师",
  "副总工程师",
  "总会计师",
  "总经济师",
  "安全总监",
  "技术负责人",
  "项目经理",
  "工会主席",
  "董事",
  "监事",
  "书记",
  "经理",
  "主任",
  "副主任",
  "部长",
  "副部长",
  "处长",
  "副处长"
].sort((left, right) => right.length - left.length);
const PERSON_LABEL_PATTERN = new RegExp(
  `(?:${PERSON_LABELS.join("|")})[\\s\\u00a0]*(?:[:：=,，、\\-—]|为|是|\\s){0,6}(${CHINESE_PERSON_NAME_PATTERN})(?=$|[\\s,，;；。.、:：)）(（]|电话|手机|联系方式|职务|岗位|身份证|邮箱|账号)`,
  "g"
);
const PERSON_TITLE_PATTERN = new RegExp(
  `(?:${PERSON_TITLE_LABELS.join("|")})(?:[\\s\\u00a0]*(?:、|,|，|/|兼|及|和)?[\\s\\u00a0]*(?:${PERSON_TITLE_LABELS.join("|")})){0,5}[\\s\\u00a0]*(${CHINESE_PERSON_NAME_PATTERN})(?=$|[\\s,，;；。.、:：)）(（]|等|出席|主持|指出|致|作|参加|参会|发言|讲话|汇报|介绍|表示|强调|要求|认为)`,
  "g"
);
const DETECTORS = [
  {
    type: "person",
    pattern: PERSON_LABEL_PATTERN,
    valueGroup: 1,
    validate: isLikelyPersonName
  },
  {
    type: "person",
    pattern: PERSON_TITLE_PATTERN,
    valueGroup: 1,
    validate: isLikelyPersonName
  },
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

function deterministicPlaceholderFallback(stableId) {
  return `<${stableId}_${sha256(`${stableId}:masked`).slice(0, 6)}>`;
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
          const originalValue = detector.valueGroup ? match[detector.valueGroup] : match[0];
          if (!originalValue) continue;
          if (detector.validate && !detector.validate(originalValue, match, segment.text)) continue;

          const index = detector.valueGroup
            ? match.index + match[0].indexOf(originalValue)
            : match.index;
          addEntitySeed(byDocAndValue, document, segment, originalValue, index, "auto");
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
  const occupiedValues = new Set(grouped.map((entity) => entity.originalValue));
  const usedMaskedValues = new Set(
    grouped
      .map((entity) => String(entity.maskedValue || "").trim())
      .filter(Boolean)
  );
  return grouped.map((entity) => {
    const counterKey = entity.docId;
    const nextIndex = (counters.get(counterKey) || 0) + 1;
    counters.set(counterKey, nextIndex);
    const stableId = makeStableId(GENERIC_ENTITY_TYPE, nextIndex);
    const maskedValue = entity.maskedValue || defaultMaskedValue(entity.originalValue, stableId, {
      occupiedValues,
      usedMaskedValues,
      createPlaceholderFallback: deterministicPlaceholderFallback
    });
    usedMaskedValues.add(maskedValue);

    return {
      id: sha256(`${entity.docId}:${entity.originalValue}`).slice(0, 16),
      docId: entity.docId,
      filePath: entity.filePath,
      type: GENERIC_ENTITY_TYPE,
      originalValue: entity.originalValue,
      maskedValue,
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
      const originalValue = detector.valueGroup ? match[detector.valueGroup] : match[0];
      if (!originalValue) continue;
      if (detector.validate && !detector.validate(originalValue, match, text)) continue;

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

export const COMMON_CHINESE_SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余于杜叶程魏苏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严赖覃洪武莫孔汤向常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳";
export const COMMON_COMPOUND_SURNAMES = [
  "欧阳",
  "司马",
  "上官",
  "诸葛",
  "司徒",
  "东方",
  "南宫",
  "夏侯",
  "尉迟",
  "公孙",
  "皇甫",
  "澹台",
  "慕容",
  "太叔",
  "端木",
  "长孙",
  "宇文",
  "司空",
  "令狐"
];
const NON_PERSON_NAME_VALUES = new Set([
  "单位",
  "部门",
  "电话",
  "手机",
  "邮箱",
  "地址",
  "职务",
  "岗位",
  "公司",
  "集团",
  "项目",
  "工程",
  "意见",
  "日期",
  "时间",
  "签章"
]);
const NON_PERSON_NAME_SUFFIX_PATTERN = /(?:公司|集团|项目|工程|部门|单位|电话|手机|邮箱|地址|岗位|职务|意见|日期|时间|签章)$/;
const CHINESE_MAINLAND_MOBILE_PATTERN = /^(\+?86[-\s]?)?(1[3-9]\d{9})$/;
export const FAKE_PERSON_NAMES = [
  "张三",
  "李四",
  "王五",
  "赵六",
  "孙七",
  "周八",
  "吴九",
  "郑十",
  "钱一",
  "冯二",
  "陈明",
  "刘强",
  "杨华",
  "黄磊",
  "胡军",
  "林峰"
];

function alphabeticLabel(index) {
  let value = Math.max(1, Number(index) || 1);
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function stableIdNumber(stableId) {
  const match = /_(\d+)$/.exec(String(stableId || ""));
  return match ? Number(match[1]) : 1;
}

export function organizationMaskSuffix(originalValue) {
  const value = String(originalValue || "").trim();
  if (!/[\u4e00-\u9fff]/.test(value)) return "";
  if (/(?:\u516c\u53f8|\u6709\u9650\u516c\u53f8|\u6709\u9650\u8d23\u4efb\u516c\u53f8|\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u5206\u516c\u53f8|\u5b50\u516c\u53f8)$/.test(value)) {
    return "\u516c\u53f8";
  }
  if (/\u96c6\u56e2$/.test(value)) return "\u96c6\u56e2";
  if (/\u9879\u76ee\u90e8$/.test(value)) return "\u9879\u76ee\u90e8";
  if (/\u4e2d\u5fc3$/.test(value)) return "\u4e2d\u5fc3";
  if (/\u7814\u7a76\u9662$/.test(value)) return "\u7814\u7a76\u9662";
  if (/\u8bbe\u8ba1\u9662$/.test(value)) return "\u8bbe\u8ba1\u9662";
  if (/\u5b66\u9662$/.test(value)) return "\u5b66\u9662";
  if (/\u533b\u9662$/.test(value)) return "\u533b\u9662";
  if (/\u5c40$/.test(value)) return "\u5c40";
  if (/(?:\u8def\u6865|\u8def\u822a|\u8700\u9053|\u5efa\u8bbe|\u5de5\u7a0b|\u6295\u8d44|\u4ea4\u901a|\u9ad8\u901f|\u94c1\u8def|\u7269\u6d41|\u8fd0\u8425|\u7ba1\u7406)/.test(value)) {
    return "\u516c\u53f8";
  }
  return "";
}

function hasCommonChineseSurname(value) {
  return COMMON_COMPOUND_SURNAMES.some((surname) => value.startsWith(surname) && value.length > surname.length) ||
    COMMON_CHINESE_SURNAMES.includes(value[0] || "");
}

export function isLikelyPersonName(originalValue) {
  const value = String(originalValue || "").trim();
  if (!/^[\u4e00-\u9fff·]{2,4}$/.test(value)) return false;
  if (!hasCommonChineseSurname(value)) return false;
  if (NON_PERSON_NAME_VALUES.has(value)) return false;
  if (NON_PERSON_NAME_SUFFIX_PATTERN.test(value)) return false;
  if (organizationMaskSuffix(value)) return false;
  return true;
}

function fallbackPlaceholderMaskedValue(stableId, occupiedValues, usedMaskedValues) {
  let index = 1;
  let candidate = `<${stableId}_MASKED_${index}>`;
  while (occupiedValues.has(candidate) || usedMaskedValues.has(candidate)) {
    index += 1;
    candidate = `<${stableId}_MASKED_${index}>`;
  }
  return candidate;
}

function placeholderMaskedValue(stableId, occupiedValues, usedMaskedValues, createFallback = fallbackPlaceholderMaskedValue) {
  const primary = `<${stableId}>`;
  if (!occupiedValues.has(primary) && !usedMaskedValues.has(primary)) return primary;
  const fallback = `<${stableId}_MASKED>`;
  if (!occupiedValues.has(fallback) && !usedMaskedValues.has(fallback)) return fallback;
  return createFallback(stableId, occupiedValues, usedMaskedValues);
}

function mobilePhoneMaskedValue(originalValue, occupiedValues) {
  const match = CHINESE_MAINLAND_MOBILE_PATTERN.exec(String(originalValue || "").trim());
  if (!match) return "";

  const prefix = match[1] || "";
  const phoneNumber = match[2];
  const candidate = `${prefix}${phoneNumber.slice(0, 3)}${"*".repeat(phoneNumber.length - 7)}${phoneNumber.slice(-4)}`;
  if (candidate !== originalValue && !occupiedValues.has(candidate)) {
    return candidate;
  }
  return "";
}

export function fakePersonMaskedValue(occupiedValues, usedMaskedValues) {
  for (const candidate of FAKE_PERSON_NAMES) {
    if (!occupiedValues.has(candidate) && !usedMaskedValues.has(candidate)) {
      return candidate;
    }
  }

  let index = 1;
  let candidate = `张三${index}`;
  while (occupiedValues.has(candidate) || usedMaskedValues.has(candidate)) {
    index += 1;
    candidate = `张三${index}`;
  }
  return candidate;
}

export function defaultMaskedValue(originalValue, stableId, options = {}) {
  const occupiedValues = options.occupiedValues || new Set();
  const usedMaskedValues = options.usedMaskedValues || new Set();

  const phoneMask = mobilePhoneMaskedValue(originalValue, occupiedValues);
  if (phoneMask) return phoneMask;

  if (isLikelyPersonName(originalValue)) {
    return fakePersonMaskedValue(occupiedValues, usedMaskedValues);
  }

  const suffix = organizationMaskSuffix(originalValue);
  if (suffix) {
    const startIndex = stableIdNumber(stableId);
    for (let offset = 0; offset < 1000; offset += 1) {
      const candidate = `${alphabeticLabel(startIndex + offset)}${suffix}`;
      if (candidate !== originalValue && !occupiedValues.has(candidate) && !usedMaskedValues.has(candidate)) {
        return candidate;
      }
    }
  }
  return placeholderMaskedValue(stableId, occupiedValues, usedMaskedValues, options.createPlaceholderFallback);
}

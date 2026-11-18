// GFF3 本地子集的纯文本解析：只解释契约明确声明的语法，不推断未声明字段。
// 坐标保持来源原值（1-based closed），phase 未知时为 null，绝不补 0。

const VALID_STRANDS = new Set(['+', '-', '.', '?']);
const VALID_PHASES = new Set(['0', '1', '2']);
const INTEGER = /^\d+$/;

// 属性分号分隔，键值等号连接，值按百分号解码；无法解码的属性记为问题而不是替换内容。
function parseAttributes(attributeText, location, issues) {
  const attributes = new Map();
  for (const token of attributeText.split(';')) {
    if (token === '') continue;
    const equal = token.indexOf('=');
    if (equal <= 0) {
      issues.push({code: 'malformed-attribute', message: '属性缺少合法键值结构', ...location, attribute: token});
      continue;
    }
    const key = token.slice(0, equal);
    const rawValue = token.slice(equal + 1);
    let value;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      issues.push({code: 'malformed-attribute', message: '属性值百分号解码失败', ...location, attribute: token});
      continue;
    }
    if (!attributes.has(key)) {
      attributes.set(key, value);
    } else {
      // 本地子集未声明重复属性键的语义，不自行取舍，留问题供复核。
      issues.push({code: 'duplicate-attribute', message: '属性键重复出现，保留首个值', ...location, attribute: key});
    }
  }
  return attributes;
}

// 解析一个分区原文，返回结构化片段与行级问题；不做跨片段合并与生物学校验。
// part 为来源分区路径，evidence 为分区原文的 SHA-256，用于行级证据回溯。
export function parsePart(text, {part, evidence} = {}) {
  const issues = [];
  const fragments = [];
  const physicalLines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let fastaStarted = false;

  physicalLines.forEach((raw, index) => {
    if (fastaStarted) return;
    const lineNumber = index + 1;
    const location = {part, line: lineNumber};
    if (raw === '') return;
    if (raw.startsWith('#')) {
      if (raw.trim() === '##FASTA') fastaStarted = true;
      return;
    }

    const columns = raw.split('\t');
    if (columns.length !== 9) {
      issues.push({code: 'malformed-line', message: '注释行不是9列tab分隔', ...location, raw});
      return;
    }
    const [seqid, , type, startText, endText, , strand, phaseText, attributeText] = columns;
    if (!seqid || !type) {
      issues.push({code: 'malformed-line', message: 'seqid与type不得为空', ...location, raw});
      return;
    }
    if (!INTEGER.test(startText) || !INTEGER.test(endText)) {
      issues.push({code: 'malformed-line', message: '坐标必须为非负整数文本', ...location, raw});
      return;
    }
    const start = Number(startText);
    const end = Number(endText);
    if (start < 1 || start > end) {
      issues.push({code: 'malformed-line', message: '坐标不符合1-based闭区间且start不大于end', ...location, raw});
      return;
    }
    if (!VALID_STRANDS.has(strand)) {
      issues.push({code: 'malformed-line', message: '链方向只允许+/-/./?', ...location, raw});
      return;
    }
    let phase = null;
    if (phaseText !== '.') {
      if (!VALID_PHASES.has(phaseText)) {
        issues.push({code: 'malformed-line', message: '编码相位只允许0/1/2或.', ...location, raw});
        return;
      }
      phase = Number(phaseText);
    }

    const attributes = parseAttributes(attributeText, location, issues);
    const id = attributes.get('ID');
    if (!id) {
      issues.push({code: 'missing-id', message: '注释行缺少ID，无法建立业务身份', ...location, raw});
      return;
    }
    const parents = [];
    const parentValue = attributes.get('Parent');
    if (parentValue !== undefined) {
      for (const piece of parentValue.split(',')) {
        if (piece === '') {
          issues.push({code: 'malformed-attribute', message: 'Parent存在空标识', ...location, raw});
          continue;
        }
        parents.push(piece);
      }
    }

    fragments.push({
      part, evidence, line: lineNumber, raw,
      seqid, type, start, end, strand, phase, id, parents,
    });
  });

  return {fragments, issues, fastaStarted};
}

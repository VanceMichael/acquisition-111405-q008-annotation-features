import {digest} from './archive.mjs';

// GFF3 本地子集解释器：只解释 source-contract 明确列出的语法，
// 不认识的字段/语法不自动补全，任何无法解释的行都变成带位置的 issue。

const STRANDS = new Set(['+', '-', '.', '?']);
const PHASES = new Set(['0', '1', '2', '.']);

export function featureKeyOf(release, seqid, id) {
  return `${release}/${seqid}/${id}`;
}

// 百分号解码；非法转义直接报错，不猜测修正。
function decodeValue(raw) {
  let output = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '%') {
      output += char;
      continue;
    }
    const hex = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new Error(`非法百分号转义：${raw.slice(index, index + 3) || '%'}`);
    }
    output += String.fromCharCode(parseInt(hex, 16));
    index += 2;
  }
  return output;
}

// 属性解析：分号分隔的 key=value，值百分号解码；Parent 逗号分隔。
function parseAttributes(attributeText) {
  const tags = new Map();
  const order = [];
  if (attributeText === '') return {tags, order};
  for (const clause of attributeText.split(';')) {
    if (clause === '' || !clause.includes('=')) {
      throw new Error(`非法属性段：${clause || '(空)'}`);
    }
    const equals = clause.indexOf('=');
    const tag = clause.slice(0, equals);
    const rawValue = clause.slice(equals + 1);
    if (tag === '') throw new Error('属性标签为空');
    if (tags.has(tag)) throw new Error(`重复属性标签：${tag}`);
    if (tag === 'Parent') {
      const parents = rawValue === '' ? [] : rawValue.split(',').map(item => {
        if (item === '') throw new Error('Parent 含空标识');
        return decodeValue(item);
      });
      tags.set(tag, parents);
    } else {
      const value = decodeValue(rawValue);
      if (tag === 'ID' && value === '') throw new Error('ID 值为空');
      tags.set(tag, value);
    }
    order.push(tag);
  }
  return {tags, order};
}

export function makeIssue(code, message, locations = []) {
  return {code, message, locations};
}

// 解析单个 part 的 GFF3 文本。##FASTA 之后全部按序列正文处理。
export function parseGff3Part(text, part, release) {
  const entries = [];
  const issues = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let fasta = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const location = {part, line: lineNumber};
    if (fasta) continue;
    if (line === '') continue;
    if (line.startsWith('##')) {
      if (line === '##FASTA') fasta = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    const columns = line.split('\t');
    if (columns.length !== 9) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行应为9列，实际${columns.length}列`, [{...location}]));
      continue;
    }
    const [seqid, source, type, startText, endText, score, strand, phaseText, attributeText] = columns;
    let attributes;
    try {
      attributes = parseAttributes(attributeText);
    } catch (error) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行${error.message}`, [{...location}]));
      continue;
    }
    const id = attributes.tags.get('ID');
    if (id === undefined) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行缺少ID，Name不能作为身份`, [{...location}]));
      continue;
    }
    if (seqid === '' || type === '') {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行列值为空`, [{...location}]));
      continue;
    }
    if (!STRANDS.has(strand)) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行链方向非法：${strand}`, [{...location}]));
      continue;
    }
    if (!PHASES.has(phaseText)) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行编码相位非法：${phaseText}`, [{...location}]));
      continue;
    }
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      issues.push(makeIssue('malformed-line', `第${lineNumber}行坐标不是整数：${startText},${endText}`, [{...location}]));
      continue;
    }
    entries.push({
      release,
      seqid,
      source,
      type,
      start,
      end,
      score,
      strand,
      phase: phaseText === '.' ? '.' : Number(phaseText),
      id,
      parents: attributes.tags.get('Parent') ?? [],
      attributeOrder: attributes.order,
      part,
      line: lineNumber,
      rawLine: line,
      evidenceHash: digest(Buffer.from(line, 'utf8')),
    });
  }
  return {entries, issues};
}

// 把同一 featureKey 的多行片段组装成一个 feature；冲突与越界不静默修正。
export function buildFeatures(entries, regionLengths, initialIssues = []) {
  const records = [];
  const issues = [...initialIssues];
  const groups = new Map();
  for (const entry of entries) {
    const key = featureKeyOf(entry.release, entry.seqid, entry.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const declared = new Set(groups.keys());

  for (const [featureKey, group] of groups) {
    const locations = group.map(item => ({part: item.part, line: item.line}));
    const sorted = [...group].sort((a, b) => a.start - b.start || a.end - b.end || a.line - b.line);
    const release = group[0].release;

    const invalidFragments = [];
    for (const item of sorted) {
      const length = regionLengths.get(item.seqid);
      if (length === undefined) {
        invalidFragments.push({entry: item, reason: `序列${item.seqid}未在regions中声明`});
        continue;
      }
      if (item.start < 1 || item.end < 1 || item.start > item.end || item.end > length) {
        invalidFragments.push({entry: item, reason: `坐标${item.start}-${item.end}越界（${item.seqid}长度${length}）`});
      }
    }
    if (invalidFragments.length > 0) {
      for (const {entry, reason} of invalidFragments) {
        issues.push(makeIssue('fragment-out-of-bounds', `特征${featureKey}片段被拒收：${reason}`, [{part: entry.part, line: entry.line}]));
      }
      issues.push(makeIssue('feature-quarantined', `特征${featureKey}含越界片段，整体不作为正常feature提交`, locations));
      continue;
    }

    const types = new Set(group.map(item => item.type));
    if (types.size > 1) {
      issues.push(makeIssue('feature-conflict', `特征${featureKey}片段类型不一致：${[...types].join(',')}`, locations));
      continue;
    }
    const strands = new Set(group.map(item => item.strand));
    if (strands.size > 1) {
      issues.push(makeIssue('feature-conflict', `特征${featureKey}片段链方向不一致：${[...strands].join(',')}`, locations));
      continue;
    }
    let conflict = false;
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].start <= sorted[index - 1].end) {
        const a = sorted[index - 1];
        const b = sorted[index];
        issues.push(makeIssue('feature-conflict', `特征${featureKey}片段坐标互相矛盾：${a.start}-${a.end}与${b.start}-${b.end}重叠`, [{part: a.part, line: a.line}, {part: b.part, line: b.line}]));
        conflict = true;
      }
    }
    if (conflict) continue;

    const parentKeys = [...new Set(group.flatMap(item =>
      item.parents.map(parent => featureKeyOf(release, item.seqid, parent))))].sort();
    const parents = parentKeys.filter(key => declared.has(key));
    const unresolvedParents = parentKeys.filter(key => !declared.has(key));
    if (unresolvedParents.length > 0) {
      issues.push(makeIssue('unresolved-parent', `特征${featureKey}引用的父项尚未到达：${unresolvedParents.join(',')}`, locations));
    }

    records.push({
      id: featureKey,
      featureKey,
      type: group[0].type,
      seqid: group[0].seqid,
      strand: group[0].strand,
      segments: sorted.map(item => ({start: item.start, end: item.end, phase: item.phase, strand: item.strand})),
      parents,
      unresolvedParents,
      sourceLines: group
        .map(item => ({part: item.part, line: item.line, rawLine: item.rawLine, evidenceHash: item.evidenceHash}))
        .sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0) || a.line - b.line),
    });
  }

  records.sort((a, b) => (a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0));
  return {records, issues};
}

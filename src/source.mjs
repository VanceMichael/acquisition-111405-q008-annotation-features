import {digest} from './archive.mjs';
import {parsePart} from './gff.mjs';

function featureKey(release, seqid, id) {
  return `${release}/${seqid}/${id}`;
}

// source 模式：领取序列声明与按区发布的注释，合并同一 feature 的多个片段，
// 保留来源坐标、链方向、编码相位、多父关系与行级证据；缺口与矛盾只记录、不修正。
export async function collectSource(transport) {
  const issues = [];
  const declarationResponse = await transport.request('/annotation');
  if (!declarationResponse.ok) throw new Error(`注释声明领取失败：${declarationResponse.status}`);

  let declaration;
  try {
    declaration = declarationResponse.json();
  } catch {
    throw new Error('注释声明不是合法JSON');
  }
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error('注释声明结构无效');
  }
  const {release, regions, parts, sealed} = declaration;
  if (typeof release !== 'string' || !release) throw new Error('注释声明缺少release');
  if (!Array.isArray(regions)) throw new Error('注释声明缺少regions序列声明');
  if (!Array.isArray(parts)) throw new Error('注释声明缺少parts分区清单');

  const regionLengths = new Map();
  for (const region of regions) {
    if (!region || typeof region.id !== 'string' || !region.id ||
        !Number.isInteger(region.length) || region.length < 1) {
      throw new Error('regions中存在无效序列声明');
    }
    if (regionLengths.has(region.id)) {
      issues.push({code: 'duplicate-region', message: '序列声明重复，以首次声明为准', seqid: region.id});
      continue;
    }
    regionLengths.set(region.id, region.length);
  }

  const features = new Map();
  const ensureFeature = key => {
    if (!features.has(key)) {
      features.set(key, {
        key, release, seqid: '', id: '', type: null,
        segments: [], parents: [], sourceLines: [], withheld: false,
      });
    }
    return features.get(key);
  };

  // 同一分区只领取一次；声明重复或非字符串链接都记为问题，不猜测替代路径。
  const seenParts = new Set();
  for (const part of parts) {
    if (typeof part !== 'string' || !part) {
      issues.push({code: 'invalid-part', message: '分区引用不是非空字符串', part: String(part)});
      continue;
    }
    if (seenParts.has(part)) {
      issues.push({code: 'duplicate-part', message: '分区被重复声明，已跳过', part});
      continue;
    }
    seenParts.add(part);

    const response = await transport.request(part);
    if (!response.ok) {
      // 分区缺失属于来源缺口：保留已收安全部分，不伪造内容。
      issues.push({code: 'part-unavailable', message: `分区领取状态：${response.status}`, part, status: response.status});
      continue;
    }
    const evidence = digest(response.bytes);
    const {fragments, issues: partIssues} = parsePart(response.text(), {part, evidence});
    issues.push(...partIssues);

    for (const fragment of fragments) {
      const key = featureKey(release, fragment.seqid, fragment.id);
      const feature = ensureFeature(key);
      const sourceLine = {
        part, evidence, line: fragment.line, raw: fragment.raw,
      };
      feature.sourceLines.push(sourceLine);

      const regionLength = regionLengths.get(fragment.seqid);
      if (regionLength === undefined) {
        // seqid 未在 regions 声明：序列声明与注释分开领取时不能当作已知序列。
        feature.withheld = true;
        issues.push({
          code: 'undeclared-region', message: '片段引用了未声明的序列',
          featureKey: key, source: sourceLine,
        });
        continue;
      }
      if (fragment.start > regionLength || fragment.end > regionLength) {
        // 坐标越界的片段不得作为正常 feature 提交，也不修正坐标。
        feature.withheld = true;
        issues.push({
          code: 'out-of-bounds', message: '片段坐标超出序列声明长度',
          featureKey: key, source: sourceLine, regionLength,
        });
        continue;
      }

      feature.seqid = fragment.seqid;
      feature.id = fragment.id;
      if (feature.type === null) {
        feature.type = fragment.type;
      } else if (feature.type !== fragment.type) {
        // 同一业务身份出现互斥类型，属于来源矛盾。
        feature.withheld = true;
        issues.push({
          code: 'type-conflict', message: '同一ID的片段类型互相矛盾',
          featureKey: key, source: sourceLine, existingType: feature.type, observedType: fragment.type,
        });
      }

      const overlap = feature.segments.some(segment =>
        fragment.start <= segment.end && segment.start <= fragment.end);
      const identical = feature.segments.some(segment =>
        segment.start === fragment.start && segment.end === fragment.end &&
        segment.strand === fragment.strand && segment.phase === fragment.phase);
      if (overlap && !identical) {
        feature.withheld = true;
        issues.push({
          code: 'overlapping-fragment', message: '同一ID的片段区间互相重叠且不一致',
          featureKey: key, source: sourceLine,
        });
      } else if (!identical) {
        feature.segments.push({
          start: fragment.start, end: fragment.end,
          phase: fragment.phase, strand: fragment.strand,
        });
      }
      for (const parent of fragment.parents) if (!feature.parents.includes(parent)) feature.parents.push(parent);
    }
  }

  // 只把至少有一个合法片段的 feature 当作可解析身份；被整体暂扣的不参与父项解析。
  const knownKeys = new Set();
  for (const feature of features.values()) {
    if (!feature.withheld && feature.segments.length > 0) knownKeys.add(feature.key);
  }

  const records = [];
  for (const feature of features.values()) {
    if (feature.withheld || feature.segments.length === 0) continue;

    const resolvedParents = [];
    const unresolvedParents = [];
    for (const parent of feature.parents) {
      const parentKey = featureKey(release, feature.seqid, parent);
      if (knownKeys.has(parentKey)) resolvedParents.push(parentKey);
      else unresolvedParents.push(parentKey);
    }
    resolvedParents.sort();
    unresolvedParents.sort();
    for (const parentKey of unresolvedParents) {
      issues.push({
        code: 'unresolved-parent', message: '引用的父项在本次领取中没有合法片段',
        featureKey: feature.key, parentKey,
      });
    }

    feature.segments.sort((a, b) =>
      (a.start - b.start) || (a.end - b.end) ||
      a.strand.localeCompare(b.strand) || ((a.phase ?? -1) - (b.phase ?? -1)));

    records.push({
      id: feature.key,
      featureKey: feature.key,
      type: feature.type,
      seqid: feature.seqid,
      segments: feature.segments,
      parents: resolvedParents,
      unresolvedParents,
      sourceLines: feature.sourceLines,
    });
  }
  records.sort((a, b) => a.featureKey.localeCompare(b.featureKey));

  const complete = sealed === true && issues.length === 0;
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}

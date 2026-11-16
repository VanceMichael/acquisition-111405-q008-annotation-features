import {parseGff3Part, buildFeatures, makeIssue} from './source-annotation.mjs';

// 结构性声明无法解释时直接失败，避免在错误前提上制造业务事实。
function validateDeclaration(declaration) {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error('注释声明不是对象');
  }
  if (typeof declaration.release !== 'string' || !declaration.release.trim()) {
    throw new Error('注释声明缺少release');
  }
  if (!Array.isArray(declaration.regions)) throw new Error('注释声明regions不是数组');
  if (!Array.isArray(declaration.parts)) throw new Error('注释声明parts不是数组');
  for (const region of declaration.regions) {
    if (!region || typeof region !== 'object' || Array.isArray(region)
      || typeof region.id !== 'string' || !region.id.trim()
      || !Number.isInteger(region.length) || region.length < 1) {
      throw new Error('注释声明regions含无效序列声明');
    }
  }
  for (const part of declaration.parts) {
    if (typeof part !== 'string' || !part.trim()) throw new Error('注释声明parts含无效片段路径');
  }
  return declaration.release;
}

function rebuild(previous, release, regionLengths) {
  const parts = previous?.release === release ? (previous.parts ?? {}) : {};
  return {
    release,
    regionLengths: [...regionLengths.entries()],
    parts,
  };
}

export async function collectSource(transport, previous = null) {
  const issues = [];
  const declarationResponse = await transport.request('/annotation');
  if (!declarationResponse.ok) throw new Error(`注释声明领取失败：${declarationResponse.status}`);
  let declaration;
  try {
    declaration = declarationResponse.json();
  } catch {
    throw new Error('注释声明不是有效JSON');
  }
  const release = validateDeclaration(declaration);

  if (previous && previous.release !== release) {
    issues.push(makeIssue(
      'release-changed',
      `来源release由${previous.release}变为${release}，旧片段缓存不再适用，按新release重建`,
      [{previousRelease: previous.release, release}],
    ));
  }

  const regionLengths = new Map();
  for (const region of declaration.regions) {
    if (regionLengths.has(region.id)) {
      issues.push(makeIssue('duplicate-region', `regions重复声明序列：${region.id}`, [{region: region.id}]));
      continue;
    }
    regionLengths.set(region.id, region.length);
  }
  if (declaration.sealed !== true) {
    issues.push(makeIssue('release-unsealed', `release ${release} 未密封，注释可能仍在变更`, []));
  }

  // 保持声明顺序；重复列出的片段只领取一次并留痕，避免把同批行解释成两次。
  const declaredParts = [];
  const seen = new Set();
  for (const part of declaration.parts) {
    if (seen.has(part)) {
      issues.push(makeIssue('duplicate-part', `parts重复列出片段：${part}`, [{part}]));
      continue;
    }
    seen.add(part);
    declaredParts.push(part);
  }

  // 行级内容寻址合并：同一(part,line)内容一致则幂等，新增行并入；
  // 同行内容变化属于来源矛盾，不静默修正，保留首次接收版本。
  const state = rebuild(previous, release, regionLengths);
  for (const part of declaredParts) {
    const cached = state.parts[part] ?? {missing: true, lines: [], parseIssues: []};
    let response;
    try {
      response = await transport.request(part);
    } catch (error) {
      // 传输失败（含越界、超时）：保留旧缓存，记录可复核缺口。
      if (!cached.missing) {
        issues.push(makeIssue('part-fetch-failed', `片段${part}再次领取失败，沿用上次安全接收的内容：${error.message}`, [{part}]));
      } else {
        issues.push(makeIssue('part-fetch-failed', `片段${part}领取失败且无历史缓存：${error.message}`, [{part}]));
        state.parts[part] = {missing: true, reason: error.message, lines: [], parseIssues: []};
      }
      continue;
    }
    if (!response.ok) {
      if (!cached.missing) {
        issues.push(makeIssue('part-unavailable', `片段${part}返回状态${response.status}，沿用上次安全接收的内容`, [{part, status: response.status}]));
        continue;
      }
      issues.push(makeIssue('part-unavailable', `片段${part}返回状态${response.status}，本片段暂缺`, [{part, status: response.status}]));
      state.parts[part] = {missing: true, status: response.status, lines: [], parseIssues: []};
      continue;
    }

    const parsed = parseGff3Part(response.text(), part, release);
    const accepted = new Map(cached.lines.map(line => [line.line, line]));
    const acceptedHashes = new Set(cached.lines.map(line => line.entry.evidenceHash));
    for (const entry of parsed.entries) {
      const existing = accepted.get(entry.line);
      if (existing) {
        if (existing.entry.evidenceHash !== entry.evidenceHash) {
          issues.push(makeIssue('line-content-changed', `片段${part}第${entry.line}行内容与已接收版本矛盾，保留首次接收版本待人工复核`, [{part, line: entry.line, previousHash: existing.entry.evidenceHash, currentHash: entry.evidenceHash}]));
        }
        continue;
      }
      if (acceptedHashes.has(entry.evidenceHash)) continue; // 行号平移、内容一致：不重复收录
      accepted.set(entry.line, {line: entry.line, entry});
      acceptedHashes.add(entry.evidenceHash);
    }
    // 坏行问题按 (位置+内容) 去重，重复领取同一片段不产生重复依据。
    const knownParseIssues = new Set(cached.parseIssues.map(item => JSON.stringify(item)));
    const parseIssues = [...cached.parseIssues];
    for (const parseIssue of parsed.issues) {
      const signature = JSON.stringify(parseIssue);
      if (!knownParseIssues.has(signature)) {
        knownParseIssues.add(signature);
        parseIssues.push(parseIssue);
      }
    }
    state.parts[part] = {
      missing: false,
      lines: [...accepted.values()].sort((a, b) => a.line - b.line),
      parseIssues,
    };
  }

  // 声明中已消失的片段：不擅自删除已收数据，但标记其不再属于当前声明。
  for (const part of Object.keys(state.parts)) {
    if (!seen.has(part)) {
      issues.push(makeIssue('part-undeclared', `片段${part}不在当前parts声明中，已收数据保留待复核`, [{part}]));
    }
  }

  const allEntries = [];
  for (const part of declaredParts) {
    const stored = state.parts[part];
    if (stored && !stored.missing) allEntries.push(...stored.lines.map(item => item.entry));
  }
  const runIssues = [...issues];
  for (const part of declaredParts) {
    const stored = state.parts[part];
    if (stored && !stored.missing) runIssues.push(...stored.parseIssues);
  }

  const {records, issues: featureIssues} = buildFeatures(allEntries, regionLengths, runIssues);
  return {records, complete: featureIssues.length === 0, issues: featureIssues, state};
}

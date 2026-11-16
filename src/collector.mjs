import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {collectSource} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  const transport = createTransport(baseUrl);
  if (mode === 'legacy') {
    const response = await transport.request('/legacy');
    if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
    const records = [normalizeLegacy(response.json())];
    await archive.commit({records, exchanges: transport.exchanges});
    return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
  }
  if (mode !== 'source') throw new Error(`不支持的来源模式：${mode}`);
  const result = await collectSource(transport, archive.snapshot().sourceState ?? null);
  await archive.commit({
    records: result.records,
    exchanges: transport.exchanges,
    issues: result.issues,
    state: result.state,
  });
  return {...result, evidenceCount: transport.exchanges.length};
}

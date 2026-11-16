import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSource} from '../src/source.mjs';

// 不经过真实HTTP的传输桩：模拟来源的连续响应与传输失败，exchanges仍被记录。
function fakeTransport(script) {
  const calls = [];
  const exchanges = [];
  return {
    exchanges,
    calls,
    async request(path) {
      calls.push(path);
      const sequence = calls.filter(item => item === path).length - 1;
      const replies = script[path];
      if (!replies) return {status: 404, ok: false, bytes: Buffer.from('未声明'), text: () => '', json: () => { throw new Error('非JSON'); }};
      const reply = replies[Math.min(sequence, replies.length - 1)];
      if (reply && reply.throwError) throw new Error(reply.throwError);
      const bytes = Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      exchanges.push({url: 'http://127.0.0.1' + path, method: 'GET', status: reply.status, headers: {}, bytes});
      return {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        bytes,
        text: () => bytes.toString('utf8'),
        json: () => JSON.parse(bytes.toString('utf8')),
      };
    },
  };
}

const declaration = (parts, sealed = true, release = 'r1') => ({
  status: 200, body: {release, regions: [{id: 'chr1', length: 1000}], parts, sealed},
});

test('特征先到、父项后到：第二次领取解除未决并完成', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1', '/p/2']), declaration(['/p/1', '/p/2'])],
    '/p/1': [{status: 200, body: 'chr1\tX\tCDS\t10\t20\t.\t+\t0\tID=c1;Parent=t1\n'}],
    '/p/2': [
      {status: 410, body: ''},
      {status: 200, body: 'chr1\tX\tmRNA\t1\t80\t.\t+\t.\tID=t1\n'},
    ],
  });
  const first = await collectSource(transport, null);
  assert.equal(first.complete, false);
  assert.deepEqual(first.records[0].unresolvedParents, ['r1/chr1/t1']);
  assert.equal(first.issues.some(issue => issue.code === 'part-unavailable'), true);

  const second = await collectSource(transport, first.state);
  assert.equal(second.complete, true);
  const feature = second.records.find(record => record.featureKey === 'r1/chr1/c1');
  assert.deepEqual(feature.parents, ['r1/chr1/t1']);
  assert.deepEqual(feature.unresolvedParents, []);
  assert.equal(second.issues.length, 0);
});

test('片段重复领取内容一致不产生重复条目，同行内容变更不静默覆盖', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1']), declaration(['/p/1'])],
    '/p/1': [
      {status: 200, body: 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n'},
      {status: 200, body: 'chr1\tX\texon\t1\t11\t.\t+\t.\tID=e1\n'},
    ],
  });
  const first = await collectSource(transport, null);
  assert.equal(first.complete, true);
  const second = await collectSource(transport, first.state);
  assert.equal(second.issues.some(issue => issue.code === 'line-content-changed'), true);
  // 保留首次接收版本：end 仍是10。
  assert.equal(second.records[0].segments[0].end, 10);
});

test('来源合法追加新行（含后到父项）时解除未决，不把追加误判为矛盾', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1']), declaration(['/p/1'])],
    '/p/1': [
      {status: 200, body: 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=later\n'},
      {status: 200, body: 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=later\nchr1\tX\tmRNA\t1\t80\t.\t+\t.\tID=later\n'},
    ],
  });
  const first = await collectSource(transport, null);
  assert.equal(first.complete, false);
  assert.deepEqual(first.records[0].unresolvedParents, ['r1/chr1/later']);
  const second = await collectSource(transport, first.state);
  assert.equal(second.complete, true);
  const exon = second.records.find(record => record.featureKey === 'r1/chr1/e1');
  assert.deepEqual(exon.parents, ['r1/chr1/later']);
  assert.deepEqual(exon.unresolvedParents, []);
});

test('传输失败时沿用历史安全缓存并标记未决，无缓存则暂缺', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1', '/p/2']), declaration(['/p/1', '/p/2'])],
    '/p/1': [{status: 200, body: 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n'}, {throwError: '来源链接越界'}],
    '/p/2': [{throwError: 'timeout'}, {throwError: 'timeout'}],
  });
  const first = await collectSource(transport, null);
  assert.equal(first.complete, false);
  assert.equal(first.issues.some(issue => issue.code === 'part-fetch-failed'), true);
  assert.equal(first.records.length, 1);
  const second = await collectSource(transport, first.state);
  assert.equal(second.records.length, 1, '已安全接收的片段不被后续失败冲掉');
  assert.equal(second.issues.some(issue => issue.code === 'part-fetch-failed' && issue.message.includes('沿用上次')), true);
});

test('未密封release永远不声明完整，空的有效结果与缺数据区分', async () => {
  const transport = fakeTransport({
    '/annotation': [{status: 200, body: {release: 'r1', regions: [{id: 'chr1', length: 1000}], parts: [], sealed: false}}],
  });
  const result = await collectSource(transport, null);
  assert.equal(result.records.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.issues.some(issue => issue.code === 'release-unsealed'), true);

  const sealedTransport = fakeTransport({
    '/annotation': [{status: 200, body: {release: 'r1', regions: [{id: 'chr1', length: 1000}], parts: [], sealed: true}}],
  });
  const sealed = await collectSource(sealedTransport, null);
  assert.equal(sealed.complete, true, '空但密封且无错误是合法的完整结果');
  assert.deepEqual(sealed.issues, []);
});

test('release变更按新release重建，不把旧片段挂到新release上', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1'], true, 'r1'), declaration(['/p/1'], true, 'r2')],
    '/p/1': [{status: 200, body: 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n'}],
  });
  const first = await collectSource(transport, null);
  assert.equal(first.records[0].featureKey, 'r1/chr1/e1');
  const second = await collectSource(transport, first.state);
  assert.equal(second.issues.some(issue => issue.code === 'release-changed'), true);
  assert.equal(second.state.release, 'r2');
  // 第二次 /p/1 无新响应，来源保持最后一次响应，内容在 r2 下重新解释。
  assert.equal(second.records[0].featureKey, 'r2/chr1/e1');
});

test('错误状态的part不产生伪原文记录，证据由传输层另行归档', async () => {
  const transport = fakeTransport({
    '/annotation': [declaration(['/p/1'])],
    '/p/1': [{status: 500, body: '内部错误'}],
  });
  const result = await collectSource(transport, null);
  assert.equal(result.records.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.issues[0].code, 'part-unavailable');
  assert.equal(result.state.parts['/p/1'].missing, true);
});

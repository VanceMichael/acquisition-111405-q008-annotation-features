import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {parsePart} from '../src/gff.mjs';

// 测试自带的本地来源：独立于 provider/fixtures，采集代码仍只通过 HTTP 接触数据。
async function startServer(routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    Buffer.concat(chunks);
    requests.push({method: request.method, path: request.url});
    const route = routes[`${request.method} ${request.url}`];
    if (!route) {
      response.writeHead(404).end('未声明');
      return;
    }
    response.writeHead(route.status ?? 200, {
      'content-type': route.type ?? 'text/plain; charset=utf-8',
    });
    response.end(route.body ?? '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests.slice(),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function annotationRoutes({release = 'rx', regions, parts, sealed = true, partBodies = {}, annotationStatus = 200, partStatuses = {}}) {
  const routes = {
    'GET /annotation': {
      status: annotationStatus,
      type: 'application/json',
      body: JSON.stringify({release, regions, parts, sealed}),
    },
  };
  for (const part of parts) {
    routes[`GET ${part}`] = {status: partStatuses[part] ?? 200, body: partBodies[part] ?? ''};
  }
  return routes;
}

async function runCollect(routes, runs = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'edge-'));
  const source = await startServer(routes);
  let result;
  let archive;
  try {
    for (let index = 0; index < runs; index++) {
      archive = await openArchive(directory);
      result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    }
  } catch (error) {
    await source.close();
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
  return {
    result, archive, directory,
    requests: source.requests(),
    cleanup: async () => {
      await source.close();
      await rm(directory, {recursive: true, force: true});
    },
  };
}

const REGIONS = [{id: 'chr1', length: 100}, {id: 'chr2', length: 50}];
const byKey = records => Object.fromEntries(records.map(record => [record.featureKey, record]));

test('多片段合并：保留坐标、链方向、编码相位、多父与行级证据，FASTA后不再解析', async () => {
  const part1 = [
    'chr1\tX\tgene\t1\t100\t.\t+\t.\tID=g1',
    'chr1\tX\tmRNA\t1\t80\t.\t+\t.\tID=t1;Parent=g1',
    'chr1\tX\tmRNA\t1\t90\t.\t?\t.\tID=t2;Parent=g1',
    'chr1\tX\tCDS\t10\t20\t.\t+\t0\tID=c1;Parent=t1,t2;Name=A%3BB',
    '',
  ].join('\n');
  const part2 = [
    'chr1\tX\tCDS\t30\t40\t.\t+\t2\tID=c1;Parent=t1,t2',
    'chr2\tX\tregion\t5\t6\t.\t-\t.\tID=r1',
    '##FASTA',
    '>chr1',
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=evil',
  ].join('\n');
  const routes = annotationRoutes({
    regions: REGIONS, parts: ['/part/1', '/part/2'],
    partBodies: {'/part/1': part1, '/part/2': part2},
  });
  const outcome = await runCollect(routes);
  try {
    const {result, archive, requests} = outcome;
    assert.equal(result.complete, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.records.length, 5);
    const records = byKey(result.records);

    const cds = records['rx/chr1/c1'];
    assert.deepEqual(cds.segments, [
      {start: 10, end: 20, phase: 0, strand: '+'},
      {start: 30, end: 40, phase: 2, strand: '+'},
    ]);
    assert.deepEqual(cds.parents, ['rx/chr1/t1', 'rx/chr1/t2']);
    assert.deepEqual(cds.unresolvedParents, []);
    assert.equal(cds.sourceLines.length, 2);
    assert.equal(cds.sourceLines[0].part, '/part/1');
    assert.equal(cds.sourceLines[0].line, 4);
    assert.match(cds.sourceLines[0].raw, /ID=c1/);
    assert.match(cds.sourceLines[0].evidence, /^[a-f0-9]{64}$/);

    // 链方向 ? 与相位 null（. 不补0）原样保留
    assert.equal(records['rx/chr1/t2'].segments[0].strand, '?');
    assert.deepEqual(records['rx/chr2/r1'].segments, [{start: 5, end: 6, phase: null, strand: '-'}]);
    // ##FASTA 之后的特征行不参与解析
    assert.equal(records['rx/chr1/evil'], undefined);
    // 行级证据指向真实归档原文
    const raw = await archive.raw(cds.sourceLines[0].evidence);
    assert.equal(raw.toString('utf8'), part1);
    // 请求有界：声明一次、分区各一次
    assert.equal(requests.length, 3);
    assert.equal(result.evidenceCount, 3);
    assert.ok(archive.snapshot().evidence.length > 0);
  } finally { await outcome.cleanup(); }
});

test('特征先于父项到达：父项在后续分区出现后按键解析，不靠名字', async () => {
  const part1 = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=t1\n';
  const part2 = 'chr1\tX\tmRNA\t1\t20\t.\t+\t.\tID=t1\n';
  const routes = annotationRoutes({
    regions: REGIONS, parts: ['/part/1', '/part/2'],
    partBodies: {'/part/1': part1, '/part/2': part2},
  });
  const outcome = await runCollect(routes);
  try {
    const exon = byKey(outcome.result.records)['rx/chr1/e1'];
    assert.deepEqual(exon.parents, ['rx/chr1/t1']);
    assert.deepEqual(exon.unresolvedParents, []);
    assert.equal(outcome.result.complete, true);
  } finally { await outcome.cleanup(); }
});

test('Name不是身份：同名特征不能顶替缺失父项', async () => {
  const body = [
    'chr1\tX\tmRNA\t1\t20\t.\t+\t.\tID=t1;Name=ghost',
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=ghost',
  ].join('\n');
  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes);
  try {
    const exon = byKey(outcome.result.records)['rx/chr1/e1'];
    assert.deepEqual(exon.parents, []);
    assert.deepEqual(exon.unresolvedParents, ['rx/chr1/ghost']);
    assert.equal(outcome.result.complete, false);
    assert.ok(outcome.result.issues.some(issue => issue.code === 'unresolved-parent'));
  } finally { await outcome.cleanup(); }
});

test('ID作用域为release+seqid：其他序列上的同名父项不解析', async () => {
  const body = [
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=x',
    'chr2\tX\tmRNA\t1\t20\t.\t+\t.\tID=x',
  ].join('\n');
  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes);
  try {
    assert.deepEqual(byKey(outcome.result.records)['rx/chr1/e1'].unresolvedParents, ['rx/chr1/x']);
  } finally { await outcome.cleanup(); }
});

test('片段互相矛盾：同ID类型冲突或区间重叠时整体暂扣并留问题', async () => {
  const conflicting = [
    'chr1\tX\tCDS\t1\t10\t.\t+\t0\tID=c1',
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=c1',
  ].join('\n');
  let routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': conflicting}});
  let outcome = await runCollect(routes);
  try {
    assert.equal(outcome.result.records.some(record => record.featureKey === 'rx/chr1/c1'), false);
    assert.ok(outcome.result.issues.some(issue => issue.code === 'type-conflict'));
    assert.equal(outcome.result.complete, false);
  } finally { await outcome.cleanup(); }

  const overlapping = [
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1',
    'chr1\tX\texon\t5\t15\t.\t+\t.\tID=e1',
  ].join('\n');
  routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': overlapping}});
  outcome = await runCollect(routes);
  try {
    assert.equal(outcome.result.records.some(record => record.featureKey === 'rx/chr1/e1'), false);
    assert.ok(outcome.result.issues.some(issue => issue.code === 'overlapping-fragment'));
  } finally { await outcome.cleanup(); }
});

test('完全重复的片段去重但保留全部行级依据，不产生矛盾问题', async () => {
  const body = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n';
  const routes = annotationRoutes({
    regions: REGIONS, parts: ['/part/1', '/part/2'],
    partBodies: {'/part/1': body, '/part/2': body},
  });
  const outcome = await runCollect(routes);
  try {
    const exon = byKey(outcome.result.records)['rx/chr1/e1'];
    assert.equal(exon.segments.length, 1);
    assert.equal(exon.sourceLines.length, 2);
    assert.deepEqual(outcome.result.issues.filter(issue => issue.code === 'overlapping-fragment'), []);
    assert.equal(outcome.result.complete, true);
  } finally { await outcome.cleanup(); }
});

test('坐标越界与未声明序列：片段不提交为正常feature，问题带来源位置', async () => {
  const body = [
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=ok',
    'chr1\tX\texon\t90\t101\t.\t+\t.\tID=bad1',
    'chr9\tX\texon\t1\t10\t.\t+\t.\tID=bad2',
  ].join('\n');
  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes);
  try {
    const keys = outcome.result.records.map(record => record.featureKey);
    assert.deepEqual(keys, ['rx/chr1/ok']);
    const codes = outcome.result.issues.map(issue => issue.code);
    assert.ok(codes.includes('out-of-bounds'));
    assert.ok(codes.includes('undeclared-region'));
    const issue = outcome.result.issues.find(item => item.code === 'out-of-bounds');
    assert.equal(issue.source.part, '/part/1');
    assert.equal(issue.source.line, 2);
    assert.equal(outcome.result.complete, false);
  } finally { await outcome.cleanup(); }
});

test('畸形行隔离：坏列、坏链方向、坏相位、坏坐标或缺ID不拖垮合法行', async () => {
  const body = [
    'chr1\tX\texon\t1\t10\t.\t+\t.',                       // 8列
    'chr1\tX\texon\t1\t10\t.\tx\t.\tID=badStrand',        // 非法链方向
    'chr1\tX\texon\t1\t10\t.\t+\t3\tID=badPhase',         // 非法相位
    'chr1\tX\texon\t0\t10\t.\t+\t.\tID=badCoord',         // 坐标不从1开始
    'chr1\tX\texon\t1\t10\t.\t+\t.\tNote=noId',           // 缺ID
    'chr1\tX\texon\t1\t10\t.\t+\t.\tID=good;Name=%ZZ',    // 坏百分号编码
    'chr1\tX\texon\t20\t30\t.\t-\t.\tID=good;Parent=p1,,p2', // 空父项标识
    'chr1\tX\texon\t40\t50\t.\t+\t.\tID=dup;Note=a;Note=b', // 重复属性键
  ].join('\n');
  const {fragments, issues} = parsePart(body, {part: '/part/1', evidence: 'x'.repeat(64)});
  // 非法链方向与非法相位的行被整体拒绝，只有三行合法ID行进入片段
  assert.deepEqual(fragments.map(fragment => fragment.id), ['good', 'good', 'dup']);
  assert.ok(issues.some(issue => issue.code === 'malformed-line'));
  assert.ok(issues.some(issue => issue.code === 'missing-id'));
  assert.ok(issues.some(issue => issue.code === 'malformed-attribute'));
  assert.ok(issues.some(issue => issue.code === 'duplicate-attribute'));

  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes);
  try {
    const good = byKey(outcome.result.records)['rx/chr1/good'];
    assert.ok(good);
    assert.deepEqual([...good.unresolvedParents].sort(), ['rx/chr1/p1', 'rx/chr1/p2']);
    assert.equal(outcome.result.complete, false);
  } finally { await outcome.cleanup(); }
});

test('sealed=false：没有其他缺口也不得声明完整', async () => {
  const body = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n';
  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], sealed: false, partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes);
  try {
    assert.equal(outcome.result.records.length, 1);
    assert.deepEqual(outcome.result.issues, []);
    assert.equal(outcome.result.complete, false);
  } finally { await outcome.cleanup(); }
});

test('分区领取失败：保留已收安全部分并记录缺口，不伪造原文', async () => {
  const routes = annotationRoutes({
    regions: REGIONS, parts: ['/part/1', '/part/2'],
    partBodies: {'/part/2': 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n'},
    partStatuses: {'/part/1': 404},
  });
  const outcome = await runCollect(routes);
  try {
    assert.equal(outcome.result.records.length, 1);
    assert.ok(outcome.result.issues.some(issue => issue.code === 'part-unavailable' && issue.status === 404));
    assert.equal(outcome.result.complete, false);
    // 404 交换按真实状态留证（status可复核），成功分区的原文才含特征行
    const evidence = outcome.archive.snapshot().evidence;
    const failed = evidence.find(item => item.url.endsWith('/part/1'));
    assert.equal(failed.status, 404);
    const succeeded = evidence.find(item => item.url.endsWith('/part/2'));
    assert.equal(succeeded.status, 200);
    const raw = await outcome.archive.raw(succeeded.hash);
    assert.match(raw.toString('utf8'), /ID=e1/);
  } finally { await outcome.cleanup(); }
});

test('空的有效结果与声明级错误状态区分', async () => {
  const empty = annotationRoutes({regions: REGIONS, parts: []});
  const outcome = await runCollect(empty);
  try {
    assert.deepEqual(outcome.result.records, []);
    assert.deepEqual(outcome.result.issues, []);
    assert.equal(outcome.result.complete, true);
    assert.equal(outcome.result.evidenceCount, 1);
  } finally { await outcome.cleanup(); }

  const broken = annotationRoutes({regions: REGIONS, parts: [], annotationStatus: 500});
  await assert.rejects(runCollect(broken), /注释声明领取失败/);
});

test('重复领取幂等：同一业务记录与原文不重复落库，记录id稳定', async () => {
  const body = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=t1\nchr1\tX\tmRNA\t1\t20\t.\t+\t.\tID=t1\n';
  const routes = annotationRoutes({regions: REGIONS, parts: ['/part/1'], partBodies: {'/part/1': body}});
  const outcome = await runCollect(routes, 2);
  try {
    const {result, archive} = outcome;
    assert.ok(result.records.every(record => typeof record.id === 'string' && record.id));
    const snapshot = archive.snapshot();
    assert.equal(snapshot.records.length, 2);
    assert.equal(new Set(snapshot.records.map(record => record.id)).size, 2);
    assert.equal(snapshot.evidence.length, 2); // 声明 + 一个分区，去重
    // 父项后到解析后记录身份在两轮运行间保持稳定
    assert.deepEqual(byKey(result.records)['rx/chr1/e1'].parents, ['rx/chr1/t1']);
  } finally { await outcome.cleanup(); }
});

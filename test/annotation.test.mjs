import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGff3Part, buildFeatures, featureKeyOf} from '../src/source-annotation.mjs';

function build(entries, regions, initialIssues = []) {
  return buildFeatures(entries, new Map(regions.map(region => [region.id, region.length])), initialIssues);
}

test('百分号解码与多父属性，Name不作为身份', () => {
  const text = 'chr1\tX\tCDS\t10\t20\t.\t+\t0\tID=c1;Parent=t1,t2;Name=A%3BB\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(issues.length, 0);
  assert.deepEqual(entries[0].parents, ['t1', 't2']);
  const {records} = build(entries, [{id: 'chr1', length: 1000}]);
  assert.equal(records[0].featureKey, 'r1/chr1/c1');
  assert.deepEqual(records[0].parents, []);
  assert.deepEqual(records[0].unresolvedParents, ['r1/chr1/t1', 'r1/chr1/t2']);
  assert.equal(records[0].segments[0].phase, 0);
  assert.equal(records[0].sourceLines[0].rawLine, text.trimEnd());
});

test('未知相位保留为.而不是补0，链方向?与.原样保留', () => {
  const text = 'chr1\tX\tmRNA\t1\t80\t.\t?\t.\tID=t1\n'
    + 'chr1\tX\texon\t1\t10\t.\t-\t.\tID=e1;Parent=t1\n';
  const {entries} = parseGff3Part(text, '/p/1', 'r1');
  const {records} = build(entries, [{id: 'chr1', length: 1000}]);
  const mrna = records.find(record => record.featureKey === 'r1/chr1/t1');
  assert.equal(mrna.strand, '?');
  assert.equal(mrna.segments[0].phase, '.');
  const exon = records.find(record => record.featureKey === 'r1/chr1/e1');
  assert.equal(exon.strand, '-');
  assert.deepEqual(exon.parents, ['r1/chr1/t1']);
  assert.deepEqual(exon.unresolvedParents, []);
});

test('##FASTA之后的序列正文不再按注释解析，指令与注释行跳过', () => {
  const text = '##gff-version 3\n# 说明行\nchr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\n##FASTA\n>chr1\nACGT\nchr1\tX\tfake\t1\t2\t.\t+\t.\tID=fake\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(issues.length, 0);
  assert.deepEqual(entries.map(entry => entry.id), ['e1']);
});

test('CRLF与BOM可正常按行处理', () => {
  const text = '﻿chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\r\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(issues.length, 0);
  assert.equal(entries[0].id, 'e1');
  assert.equal(entries[0].line, 1);
});

test('坏行不污染同行part内的合法行，且留下带行号的issue', () => {
  const text = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=ok1\n'
    + 'bad-line\n'
    + 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=ok2;Parent=100%ZZ\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.deepEqual(entries.map(entry => entry.id), ['ok1']);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].code, 'malformed-line');
  assert.deepEqual(issues[0].locations, [{part: '/p/1', line: 2}]);
  assert.equal(issues[1].locations[0].line, 3);
});

test('缺少ID的行拒收，不能凭Name猜身份', () => {
  const text = 'chr1\tX\tgene\t1\t10\t.\t+\t.\tName=only-name\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(entries.length, 0);
  assert.match(issues[0].message, /缺少ID/);
});

test('非法链方向与相位分别拒收', () => {
  const text = 'chr1\tX\texon\t1\t10\t.\tx\t.\tID=bad-strand\n'
    + 'chr1\tX\texon\t1\t10\t.\t+\t5\tID=bad-phase\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(entries.length, 0);
  assert.match(issues[0].message, /链方向非法/);
  assert.match(issues[1].message, /编码相位非法/);
});

test('非整数坐标拒收为坏行', () => {
  const text = 'chr1\tX\texon\ta\t10\t.\t+\t.\tID=e1\n';
  const {entries, issues} = parseGff3Part(text, '/p/1', 'r1');
  assert.equal(entries.length, 0);
  assert.match(issues[0].message, /坐标不是整数/);
});

test('同一特征跨part片段合并、排序并保留全部行级依据', () => {
  const first = parseGff3Part('chr1\tX\tCDS\t30\t40\t.\t+\t2\tID=c1;Parent=t1\n', '/p/2', 'r1');
  const second = parseGff3Part('chr1\tX\tCDS\t10\t20\t.\t+\t0\tID=c1;Parent=t1\n', '/p/1', 'r1');
  const {records, issues} = build([...first.entries, ...second.entries], [{id: 'chr1', length: 1000}]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].segments.map(segment => [segment.start, segment.end, segment.phase]), [[10, 20, 0], [30, 40, 2]]);
  assert.equal(records[0].sourceLines.length, 2);
  assert.deepEqual(records[0].sourceLines.map(line => line.part), ['/p/1', '/p/2']);
  // 父项t1未到达：可暂收但必须留下未决依据。
  assert.deepEqual(records[0].unresolvedParents, ['r1/chr1/t1']);
  assert.equal(issues[0].code, 'unresolved-parent');
});

test('片段重叠属于互相矛盾，整体拒收且不修正坐标', () => {
  const text = 'chr1\tX\texon\t10\t30\t.\t+\t.\tID=e1\nchr1\tX\texon\t20\t40\t.\t+\t.\tID=e1\n';
  const {entries} = parseGff3Part(text, '/p/1', 'r1');
  const {records, issues} = build(entries, [{id: 'chr1', length: 1000}]);
  assert.equal(records.length, 0);
  assert.equal(issues.some(issue => issue.code === 'feature-conflict'), true);
});

test('片段类型或链方向矛盾时拒收整组', () => {
  const typeClash = parseGff3Part('chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1\nchr1\tX\tgene\t20\t30\t.\t+\t.\tID=e1\n', '/p/1', 'r1');
  const result1 = build(typeClash.entries, [{id: 'chr1', length: 1000}]);
  assert.equal(result1.records.length, 0);
  assert.equal(result1.issues[0].code, 'feature-conflict');

  const strandClash = parseGff3Part('chr1\tX\texon\t1\t10\t.\t+\t.\tID=e2\nchr1\tX\texon\t20\t30\t.\t-\t.\tID=e2\n', '/p/2', 'r1');
  const result2 = build(strandClash.entries, [{id: 'chr1', length: 1000}]);
  assert.equal(result2.records.length, 0);
  assert.match(result2.issues[0].message, /链方向不一致/);
});

test('越界片段使整组特征不提交，但独立特征不受牵连', () => {
  const text = 'chr1\tX\texon\t1\t101\t.\t-\t.\tID=e1\nchr1\tX\tgene\t1\t10\t.\t-\t.\tID=g1\n';
  const {entries} = parseGff3Part(text, '/p/1', 'r2');
  const {records, issues} = build(entries, [{id: 'chr1', length: 100}]);
  assert.deepEqual(records.map(record => record.featureKey), ['r2/chr1/g1']);
  assert.equal(issues.some(issue => issue.code === 'fragment-out-of-bounds'), true);
  assert.equal(issues.some(issue => issue.code === 'feature-quarantined'), true);
  assert.ok(issues.every(issue => issue.locations.length > 0));
});

test('start>end及起点小于1同样判为越界', () => {
  const text = 'chr1\tX\texon\t50\t10\t.\t+\t.\tID=e1\nchr1\tX\texon\t0\t10\t.\t+\t.\tID=e2\n';
  const {entries} = parseGff3Part(text, '/p/1', 'r1');
  const {records, issues} = build(entries, [{id: 'chr1', length: 100}]);
  assert.equal(records.length, 0);
  assert.equal(issues.filter(issue => issue.code === 'fragment-out-of-bounds').length, 2);
});

test('seqid未在regions声明时按越界处理，不凭空接受', () => {
  const {entries} = parseGff3Part('chr9\tX\texon\t1\t10\t.\t+\t.\tID=e1\n', '/p/1', 'r1');
  const {records, issues} = build(entries, [{id: 'chr1', length: 100}]);
  assert.equal(records.length, 0);
  assert.match(issues[0].message, /未在regions中声明/);
});

test('父项在后续片段到达后自动解除未决，且不凭名字猜测', () => {
  const child = parseGff3Part('chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=absent\n', '/p/1', 'r3');
  const first = build(child.entries, [{id: 'chr1', length: 100}]);
  assert.deepEqual(first.records[0].unresolvedParents, [featureKeyOf('r3', 'chr1', 'absent')]);
  const parent = parseGff3Part('chr1\tX\tmRNA\t1\t80\t.\t+\t.\tID=absent\n', '/p/2', 'r3');
  const second = build([...child.entries, ...parent.entries], [{id: 'chr1', length: 100}]);
  assert.deepEqual(second.records.find(record => record.featureKey === 'r3/chr1/e1').parents, ['r3/chr1/absent']);
  assert.deepEqual(second.records.find(record => record.featureKey === 'r3/chr1/e1').unresolvedParents, []);
});

test('父项引用去重，parents与unresolvedParents分别按完整键排序', () => {
  const text = 'chr1\tX\texon\t1\t10\t.\t+\t.\tID=e1;Parent=z,a,a\n';
  const {entries} = parseGff3Part(text, '/p/1', 'r1');
  const {records} = build(entries, [{id: 'chr1', length: 100}]);
  assert.deepEqual(records[0].unresolvedParents, ['r1/chr1/a', 'r1/chr1/z']);
});

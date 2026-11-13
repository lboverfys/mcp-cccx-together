import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectEvidence } from '../src/evidence.mjs';

function workspace(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-team-evidence-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  write('src/app.js', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  write('README.md', '# 标题\r\n第二行\r\n');
  return { dir, root, write };
}

test('按 文件:行号、区间和 #L 引用读出原文，单行带上下文，绝对路径和 Windows 换行都可识别', t => {
  const w = workspace(t);
  const evidence = collectEvidence(
    `结论见 src/app.js:5，区间 [链接](${w.root}/src/app.js:10-12)，另见 \`src/app.js#L1\` 和 README.md:2。`, [w.root]);
  assert.deepEqual(evidence.map(item => [item.ref, item.file, item.ok, item.lines]), [
    ['src/app.js:5', 'src/app.js', true, '3-7'],
    [`${w.root}/src/app.js:10-12`, 'src/app.js', true, '10-12'],
    ['src/app.js#L1', 'src/app.js', true, '1-3'],
    ['README.md:2', 'README.md', true, '1-2'],
  ]);
  assert.equal(evidence[0].text, '3| line 3\n4| line 4\n5| line 5\n6| line 6\n7| line 7');
  assert.equal(evidence[3].text, '1| # 标题\n2| 第二行');
});

test('不存在的文件和超出范围的行号标记为无效，裸文件名、URL、IP、时间和项目外路径不报告', t => {
  const w = workspace(t);
  const evidence = collectEvidence([
    'src/gone.js:3', 'src/app.js:99', 'main.go:12', 'http://example.com:8080/x', '127.0.0.1:8080',
    '12:30:45', '../outside.txt:1', '/etc/hosts:1', 'src/app.js:0', 'src/gone.js:4',
  ].join(' '), [w.root]);
  assert.deepEqual(evidence, [
    { ref: 'src/gone.js:3', ok: false, reason: '工作目录内找不到该文件' },
    { ref: 'src/app.js:99', file: 'src/app.js', ok: false, reason: '行号超出文件范围（共 30 行）' },
  ]);
});

test('引用去重并限制数量与篇幅，长区间截短', t => {
  const w = workspace(t);
  w.write('src/long.js', `${'x'.repeat(1000)}\n`.repeat(40));
  const refs = ['src/app.js:5', 'src/app.js:5', ...Array.from({ length: 12 }, (_, i) => `src/long.js:${i * 3 + 1}`)];
  const evidence = collectEvidence(refs.join(' '), [w.root]);
  assert.equal(evidence.length, 8);
  assert.equal(evidence.filter(item => item.ref === 'src/app.js:5').length, 1);
  assert.ok(evidence.every(item => !item.text || item.text.split('\n').every(line => line.length <= 250)));
  assert.ok(evidence.some(item => item.ok && item.text === undefined), '超过总篇幅后只保留引用位置');
  const [range] = collectEvidence('src/app.js:1-30', [w.root]);
  assert.equal(range.lines, '1-12');
});

test('隔离工作区优先于主工作区，主工作区路径和隔离路径都能定位', t => {
  const w = workspace(t);
  const isolated = path.join(w.dir, 'worktree');
  mkdirSync(path.join(isolated, 'src'), { recursive: true });
  writeFileSync(path.join(isolated, 'src/app.js'), 'isolated 1\nisolated 2\n');
  // 主工作区路径和隔离路径指向同一行时只报告一次；隔离工作区里没有的文件回落到主工作区。
  const evidence = collectEvidence(`src/app.js:1 ${w.root}/src/app.js:2 ${isolated}/src/app.js:2 README.md:1`, [isolated, w.root]);
  assert.deepEqual(evidence.map(item => [item.ref, item.text]), [
    ['src/app.js:1', '1| isolated 1\n2| isolated 2'],
    [`${w.root}/src/app.js:2`, '1| isolated 1\n2| isolated 2'],
    ['README.md:1', '1| # 标题\n2| 第二行'],
  ]);
});

test('指向项目外的符号链接不读取', t => {
  const w = workspace(t);
  writeFileSync(path.join(w.dir, 'secret.txt'), 'secret\n');
  try { symlinkSync(path.join(w.dir, 'secret.txt'), path.join(w.root, 'src/link.txt')); }
  catch (error) { t.skip(`当前环境不能创建符号链接：${error.code}`); return; }
  assert.deepEqual(collectEvidence('src/link.txt:1', [w.root]), []);
});

test('中文路径和紧贴说明文字的引用都能定位，找不到时报告去掉说明文字后的路径', t => {
  const w = workspace(t);
  w.write('网关/转发.go', 'a\nb\nc\nd\ne\n');
  const evidence = collectEvidence([
    '见 网关/转发.go:3', `绝对路径 ${w.root}/网关/转发.go:1`, '根因位于src/app.js:2', '另见网关/转发.go#L5',
    '这里写错了src/gone.js:4', '对应main.go:1行',
  ].join('；'), [w.root]);
  assert.deepEqual(evidence.map(item => [item.ref, item.file, item.ok, item.lines]), [
    ['网关/转发.go:3', '网关/转发.go', true, '1-5'],
    [`${w.root}/网关/转发.go:1`, '网关/转发.go', true, '1-3'],
    ['src/app.js:2', 'src/app.js', true, '1-4'],
    ['网关/转发.go#L5', '网关/转发.go', true, '3-5'],
    ['src/gone.js:4', undefined, false, undefined],
  ]);
  assert.equal(evidence[0].text, '1| a\n2| b\n3| c\n4| d\n5| e');
});

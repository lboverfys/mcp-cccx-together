import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { inside, pathKey, physicalPath, toPosix } from './paths.mjs';

const MAX_REFERENCES = 8;
const CONTEXT_LINES = 2;
const MAX_RANGE_LINES = 12;
const LINE_CHARS = 240;
const TOTAL_CHARS = 6000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// 只扫描报告开头；超长交付后部的引用主控本来也不会读到。
const SCAN_CHARS = 50000;
// 每个引用最多尝试的前缀剥离次数，防止长段无标点中文逐字试探。
const MAX_CANDIDATES = 32;
// 文件:行号、文件:起-止、文件#L行号；路径可含中文等非 ASCII 字符，路径前不能紧接 ASCII 路径字符，行号后不能紧接数字。
const REFERENCE = /(?<![\w./\\-])((?:[A-Za-z]:)?[\p{L}\p{N}_./\\-]+?)(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)(?!\d)/gu;
const hasSeparator = path => /[/\\]/.test(path);
const looksLikeFile = path => hasSeparator(path) || /\.[A-Za-z]\w*$/.test(path);
const ascii = char => char.charCodeAt(0) < 0x80;

/**
 * 中文行文常把路径紧贴在说明文字后面（如“位于src/a.go:3”），匹配会带上前面的字。
 * 依次去掉第一段中非 ASCII 字符之前的部分作为候选，由文件系统判定哪一个是真实路径；按从长到短排列。
 */
function candidates(text) {
  const firstSeparator = text.search(/[/\\]/);
  const limit = firstSeparator < 0 ? text.length : firstSeparator + 1;
  const result = [text];
  let offset = 0;
  for (const char of text) {
    offset += char.length;
    if (offset >= limit || result.length >= MAX_CANDIDATES) break;
    if (!ascii(char)) result.push(text.slice(offset));
  }
  return result;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** 找到引用对应的项目文件：绝对路径须位于某个根目录内，相对路径按根目录顺序查找；不在项目内返回 undefined。 */
function locate(target, roots, platform) {
  const key = path => pathKey(path, platform);
  let rel = target;
  if (isAbsolute(target)) {
    const full = resolve(target);
    const root = roots.find(item => inside(key(item), key(full)));
    if (!root) return undefined;
    rel = relative(root, full);
  }
  let inProject = false;
  for (const root of roots) {
    const full = resolve(root, rel);
    if (!inside(key(root), key(full))) continue;
    inProject = true;
    if (!isFile(full)) continue;
    // 符号链接指向项目外时不读取。
    try { if (!inside(key(physicalPath(root)), key(physicalPath(full)))) return undefined; } catch { return undefined; }
    return { full, file: toPosix(relative(root, full)) };
  }
  return inProject ? null : undefined;
}

/**
 * 从工作者报告中提取 文件:行号 引用并读出对应原文，主控不必再打开文件核对。
 * roots 按优先级排列（隔离工作区在前，主工作区在后）；只读取根目录内的文件。
 * 有目录分隔符却找不到的文件、超出文件行数的行号标记为 ok: false；
 * 没有目录的裸文件名找不到时不报告，避免把主机名、版本号之类误判为伪造引用。
 */
export function collectEvidence(text, roots, { platform = process.platform } = {}) {
  const evidence = [];
  const seen = new Set();
  const files = new Map();
  let budget = TOTAL_CHARS;
  for (const match of String(text ?? '').slice(0, SCAN_CHARS).matchAll(REFERENCE)) {
    if (evidence.length >= MAX_REFERENCES) break;
    const [matched, raw] = match;
    const location = matched.slice(raw.length);
    const start = Number(match[2] ?? match[4]);
    const end = Number(match[3] ?? match[5] ?? start);
    if (start < 1) continue;
    let found;
    let path;
    const missing = [];
    for (const candidate of candidates(raw)) {
      if (!looksLikeFile(candidate) || candidate.startsWith('//')) continue;
      const located = locate(candidate, roots, platform);
      if (located) { found = located; path = candidate; break; }
      if (located === null) missing.push(candidate);
    }
    if (!found) {
      // 都找不到时优先报告去掉说明文字、以 ASCII 开头的路径；裸文件名找不到不报告，避免误判主机名、版本号。
      path = missing.find(candidate => candidate !== raw && ascii(candidate[0])) ?? missing[0];
      if (!path || !hasSeparator(path)) continue;
      if (seen.has(`missing:${path}`)) continue;
      seen.add(`missing:${path}`);
      evidence.push({ ref: `${path}${location}`, ok: false, reason: '工作目录内找不到该文件' });
      continue;
    }
    const ref = `${path}${location}`;
    const id = `${found.full}:${start}-${end}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let lines = files.get(found.full);
    if (!lines) {
      try {
        if (statSync(found.full).size > MAX_FILE_BYTES) { evidence.push({ ref, file: found.file, ok: false, reason: '文件过大，未读取' }); continue; }
        lines = readFileSync(found.full, 'utf8').split(/\r?\n/);
        if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      } catch (error) {
        evidence.push({ ref, file: found.file, ok: false, reason: `读取失败：${error.message}` });
        continue;
      }
      files.set(found.full, lines);
    }
    if (start > lines.length) {
      evidence.push({ ref, file: found.file, ok: false, reason: `行号超出文件范围（共 ${lines.length} 行）` });
      continue;
    }
    // 单行引用带上下文；区间引用只取区间本身，过长时截短。
    const ranged = end > start;
    const from = ranged ? start : Math.max(1, start - CONTEXT_LINES);
    const to = Math.min(lines.length, ranged ? Math.min(end, start + MAX_RANGE_LINES - 1) : start + CONTEXT_LINES);
    const item = { ref, file: found.file, ok: true, lines: `${from}-${to}` };
    if (budget > 0) {
      item.text = lines.slice(from - 1, to).map((line, index) => `${from + index}| ${line.slice(0, LINE_CHARS)}`).join('\n');
      budget -= item.text.length;
    }
    evidence.push(item);
  }
  return evidence;
}

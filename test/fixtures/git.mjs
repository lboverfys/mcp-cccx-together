import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 在临时目录创建带一次提交的 git 仓库；状态和临时目录位于仓库外。 */
export function gitRepository(t, files = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-team-worktree-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  // 固定换行和签名设置，测试结果不受运行环境的全局 git 配置影响。
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    git('config', key, value);
  }
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  for (const [file, content] of Object.entries(files)) write(file, content);
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, root, git, write, read: file => readFileSync(path.join(root, file), 'utf8'),
    tempDir: path.join(dir, 'runtime'), worktreeRoot: path.join(dir, 'state', 'worktree') };
}

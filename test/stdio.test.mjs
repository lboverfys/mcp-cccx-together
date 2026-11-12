import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('真实 stdio 入口完成握手、团队恢复与 EOF 收尾，零模型请求', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-team-stdio-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ claudeExecutable: process.execPath,
    stateDir: path.join(dir, 'state'), tempDir: path.join(dir, 'runtime'), notificationMode: 'poll' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--config', configPath],
    cwd: dir, stderr: 'pipe',
    env: { ...process.env, CC_TEAM_CONFIG: configPath, CC_TEAM_STATE_DIR: path.join(dir, 'state'), CC_TEAM_TEMP_DIR: path.join(dir, 'runtime') },
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  let pid;
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    pid = transport.pid;
    assert(pid && alive(pid));
    assert.equal((await client.listTools()).tools.length, 16);
    assert.deepEqual((await call('team_list')).teams, []);
    const opened = await call('team_open', { teamId: 'portable', constraints: '保留跨会话约束' });
    assert.equal(opened.notifications, false);
    assert.equal(existsSync(path.join(dir, 'state', 'portable', 'store.lock')), true);
    await call('team_shutdown');
    assert.equal(existsSync(path.join(dir, 'state', 'portable', 'store.lock')), false);
    assert.deepEqual((await call('team_list')).teams, [{ teamId: 'portable', current: false }]);
    await call('team_open', { teamId: 'portable' });
    // 直接结束客户端输入，验证 server 自行关闭团队并释放锁。
    await client.close();
    for (let i = 0; i < 40 && alive(pid); i++) await delay(50);
    assert.equal(alive(pid), false, stderr);
    assert.equal(existsSync(path.join(dir, 'state', 'portable', 'store.lock')), false);
    assert.equal(stderr, '');
  } finally {
    await client.close();
    if (pid) assert.equal(alive(pid), false, '本次 stdio 子进程未退出');
    const relative = path.relative(tmpdir(), dir);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(dir, { recursive: true, force: true });
  }
});

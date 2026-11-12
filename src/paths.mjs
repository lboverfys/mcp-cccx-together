import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** path 位于 root 内（含 root 本身）。两者都应是同一形式的绝对路径。 */
export const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

/** 解析符号链接后的物理路径；不存在的尾部按最近的已存在祖先拼接。 */
export function physicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physicalPath(parent), basename(path));
  }
}

export const caseInsensitivePaths = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

/** 路径比较键：Windows 和 macOS 默认文件系统不区分大小写。 */
export const pathKey = (path, platform = process.platform) => caseInsensitivePaths(platform) ? path.toLowerCase() : path;

export const toPosix = path => path.split(sep).join('/');

#!/usr/bin/env node
/**
 * sync-agent-skills.mjs — 让 DSH / Codex / Claude Code 共用同一批 SKILL.md，接手即用、无需重新下载。
 *
 * 子命令:
 *   status                                 # 查看三家发现目录与技能数量
 *   link [--to <dir>] [--force]            # 建立项目级软链 .claude/skills、.agents/skills -> skills/
 *   import --from <dir> [--force]          # 把已有技能目录(含 SKILL.md)复制进仓库 skills/ 随 Git 走
 *   mirror --from <dir> --to <dir> [--force]# 把技能以软链方式挂到某 Agent 的用户级目录
 *
 * Windows 使用 junction（fs.symlink 'junction'，无需管理员）；POSIX 使用目录软链。
 * 所有操作幂等；已存在且非 --force 时跳过，不覆盖真实目录。
 */
import { existsSync, lstatSync, readlinkSync, readdirSync, mkdirSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CANON = join(REPO, 'skills');
const IS_WIN = process.platform === 'win32';
const LINK_TYPE = IS_WIN ? 'junction' : 'dir';
const home = homedir();

function parse(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  const opts = {};
  for (let i = argv[0] === cmd ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  }
  return { cmd, opts };
}
const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const skillDirs = (dir) => list(dir).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md'))).map((d) => d.name);
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const realDir = (p) => { try { return lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink(); } catch { return false; } };

function status() {
  console.log('repo            :', REPO);
  console.log('canonical skills:', CANON, '(SKILL.md dirs =', skillDirs(CANON).length + ')');
  for (const rel of ['.agents/skills', '.claude/skills']) {
    const p = join(REPO, rel);
    let kind = 'absent';
    if (isLink(p)) kind = 'link -> ' + (() => { try { return readlinkSync(p); } catch { return '?'; } })();
    else if (realDir(p)) kind = 'real dir';
    console.log(`${rel.padEnd(15)}:`, kind, '(skills =', skillDirs(p).length + ')');
  }
  for (const [label, p] of [
    ['~/.agents/skills', join(home, '.agents', 'skills')],
    ['~/.claude/skills', join(home, '.claude', 'skills')],
    ['~/.codex/skills', join(home, '.codex', 'skills')],
  ]) {
    console.log(`${label.padEnd(16)}:`, existsSync(p) ? 'present' : 'absent', '(skills =', skillDirs(p).length + ')');
  }
}

function linkOne(linkPath, target, force) {
  mkdirSync(resolve(linkPath, '..'), { recursive: true });
  if (existsSync(linkPath) || isLink(linkPath)) {
    if (realDir(linkPath)) { console.log('SKIP (real dir exists):', linkPath); return; }
    if (!force) { console.log('SKIP (link exists, use --force):', linkPath); return; }
    rmSync(linkPath, { recursive: false, force: true });
  }
  symlinkSync(target, linkPath, LINK_TYPE);
  console.log('LINKED', linkPath, '->', target);
}

function link(opts) {
  const target = resolve(opts.to || CANON);
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  for (const rel of ['.agents/skills', '.claude/skills']) linkOne(join(REPO, rel), target, opts.force);
}

function importSkills(opts) {
  if (!opts.from) throw new Error('import requires --from <dir>');
  const src = resolve(opts.from);
  mkdirSync(CANON, { recursive: true });
  const names = skillDirs(src);
  if (!names.length) { console.log('no SKILL.md dirs under', src); return; }
  let copied = 0;
  for (const name of names) {
    const dst = join(CANON, name);
    if (existsSync(dst) && !opts.force) { console.log('SKIP existing:', name); continue; }
    if (opts.force) rmSync(dst, { recursive: true, force: true });
    cpSync(join(src, name), dst, { recursive: true });
    copied++;
    console.log('IMPORTED', name);
  }
  console.log(`done: ${copied}/${names.length} imported into skills/`);
}

function mirror(opts) {
  if (!opts.from || !opts.to) throw new Error('mirror requires --from <dir> --to <dir>');
  const src = resolve(opts.from), dst = resolve(opts.to);
  mkdirSync(dst, { recursive: true });
  const names = skillDirs(src);
  for (const name of names) linkOne(join(dst, name), join(src, name), opts.force);
  console.log(`done: mirrored ${names.length} skills -> ${dst}`);
}

try {
  const { cmd, opts } = parse(process.argv.slice(2));
  if (cmd === 'status') status();
  else if (cmd === 'link') { link(opts); status(); }
  else if (cmd === 'import') importSkills(opts);
  else if (cmd === 'mirror') mirror(opts);
  else { console.error('unknown command:', cmd); process.exitCode = 2; }
} catch (error) {
  console.error('ERROR:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

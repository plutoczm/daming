import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync,
  renameSync, writeFileSync
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { secureNewWindowsDirectory } from './windows-private-acl.ts';

const TASK_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.go', '.yml', '.yaml']);
const BLOCKED_SEGMENTS = /^(?:node_modules|dist|build|coverage|runtime|cache|data|vendor|secrets?|credentials?|private|__pycache__)$/i;
const BLOCKED_NAMES = /(?:^\.|\.env|\.lock$|\.key$|\.pem$|\.p12$|^id_rsa|^auth\.json$|^config\.toml$|password|token|credential|secret)/i;
const MAX_FILES = 8;
const MAX_FILE_BYTES = 16 * 1024;
export const MAX_RUNTIME_WORKSPACE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = MAX_RUNTIME_WORKSPACE_BYTES;
const MAX_PROPOSAL_BYTES = 24 * 1024;

type Manifest = {
  readonly taskId: string;
  readonly root: string;
  readonly files: readonly string[];
};
export interface ProjectChangeView {
  readonly taskId: string;
  readonly filename: string;
  readonly before: string;
  readonly after: string;
  readonly reviewerNote: string;
  readonly originalUnchanged: boolean;
  readonly verified: boolean;
  readonly mergeEnabled: false;
}
export type RuntimeSeedFile = Readonly<{ path: string; text: string }>;
export class ProjectPreviewError extends Error {}

/** Treat file paths as a precise, user-reviewed capability. Never accept directories, globs or arbitrary paths. */
export function validateProjectFiles(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FILES) throw new ProjectPreviewError('project_files_invalid');
  const found = new Set<string>();
  const files: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string' || value.length > 200 || value.includes('\u0000') ||
        isAbsolute(value) || value.startsWith('/') || value.includes('\\') || value.includes(':')) {
      throw new ProjectPreviewError('project_file_path_invalid');
    }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' ||
      part.endsWith(' ') || part.endsWith('.') || !/^[A-Za-z0-9_.-]+$/.test(part) ||
      BLOCKED_SEGMENTS.test(part) || BLOCKED_NAMES.test(part))) {
      throw new ProjectPreviewError('project_file_path_denied');
    }
    const last = parts.at(-1)!;
    const ext = last.slice(last.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new ProjectPreviewError('project_extension_denied');
    const key = value.toLowerCase();
    if (found.has(key)) throw new ProjectPreviewError('project_duplicate_file');
    found.add(key);
    files.push(value);
  }
  return files;
}

function safeTaskId(value: string): void {
  if (!TASK_ID.test(value)) throw new ProjectPreviewError('invalid_project_task_id');
}

function childWithin(parent: string, child: string): boolean {
  const p = resolve(parent).toLowerCase();
  const c = resolve(child).toLowerCase();
  return c !== p && c.startsWith(p + sep.toLowerCase());
}

function guardedFile(root: string, filename: string): string {
  const parts = filename.split('/');
  const rootReal = realpathSync.native(root);
  let cursor = root;
  for (const segment of parts) {
    cursor = join(cursor, segment);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new ProjectPreviewError('project_file_link_denied');
  }
  const target = realpathSync.native(cursor);
  if (!childWithin(rootReal, target)) throw new ProjectPreviewError('project_file_escaped');
  const info = lstatSync(target);
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) {
    throw new ProjectPreviewError('project_file_type_or_size_denied');
  }
  return target;
}

function textBytes(buffer: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (text.includes('\u0000')) throw new ProjectPreviewError('project_binary_file_denied');
  return text;
}

function writeNew(filename: string, data: string): void {
  mkdirSync(resolve(filename, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(filename, data, { flag: 'wx', mode: 0o600 });
}

/** Reject extra files/junctions even if a model ignored its documented read-only mode. */
function requireExactFiles(root: string, names: readonly string[]): void {
  const expected = new Set(names.map((item) => item.replaceAll('\\', '/')));
  const dirs = new Set<string>();
  for (const name of expected) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const visit = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder)) {
      const rel = prefix ? prefix + '/' + name : name;
      const filename = join(folder, name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new ProjectPreviewError('project_unexpected_link');
      if (stat.isDirectory()) {
        if (!dirs.has(rel)) throw new ProjectPreviewError('project_unexpected_directory');
        visit(filename, rel);
      } else if (!stat.isFile() || stat.nlink !== 1 || !expected.has(rel)) {
        throw new ProjectPreviewError('project_unexpected_file');
      }
    }
  };
  visit(root, '');
}

function manifestAt(folder: string): Manifest {
  const raw = readFileSync(guardedFile(folder, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as Manifest;
  if (!manifest || typeof manifest.taskId !== 'string' || typeof manifest.root !== 'string') {
    throw new ProjectPreviewError('project_manifest_invalid');
  }
  validateProjectFiles(manifest.files);
  return manifest;
}

/** Host-owned staging. It is not an OS sandbox and must not contain credentials or linked directories. */
export class ProjectWorkspace {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;

  constructor(sourceRoot: string, workspaceRoot: string) {
    if (!sourceRoot || !workspaceRoot) throw new ProjectPreviewError('project_roots_required');
    const src = resolve(sourceRoot);
    const target = resolve(workspaceRoot);
    if (!existsSync(src) || !lstatSync(src).isDirectory() || lstatSync(src).isSymbolicLink() ||
      childWithin(src, target) || childWithin(target, src) || src.toLowerCase() === target.toLowerCase()) {
      throw new ProjectPreviewError('project_root_untrusted');
    }
    this.sourceRoot = realpathSync.native(src);
    this.workspaceRoot = target;
  }

  folder(taskId: string): string {
    safeTaskId(taskId);
    return join(this.workspaceRoot, taskId);
  }

  /** Fast read-only preflight; catches missing links and oversized prompts before task creation. */
  preflight(input: unknown): string[] {
    return this.selectedSourceFiles(input).map((entry) => entry.file);
  }

  private selectedSourceFiles(input: unknown): { file: string; content: string; bytes: number }[] {
    const files = validateProjectFiles(input);
    const entries = files.map((file) => {
      try {
        const raw = readFileSync(guardedFile(this.sourceRoot, file));
        const content = textBytes(raw);
        return { file, content, bytes: raw.byteLength };
      } catch (error) {
        if (error instanceof ProjectPreviewError) throw error;
        throw new ProjectPreviewError('project_file_unavailable');
      }
    });
    if (entries.reduce((count, entry) => count + entry.bytes, 0) > MAX_TOTAL_BYTES ||
        Buffer.byteLength(entries.map((entry) => JSON.stringify({
          path: entry.file, text: entry.content
        })).join('\n'), 'utf8') > 22_000) {
      throw new ProjectPreviewError('project_bundle_too_large');
    }
    return entries;
  }

  import(taskId: string, input: unknown): string[] {
    safeTaskId(taskId);
    const sourceFiles = this.selectedSourceFiles(input);
    const files = sourceFiles.map((entry) => entry.file);
    if (!existsSync(this.workspaceRoot)) {
      mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
      secureNewWindowsDirectory(this.workspaceRoot);
    }
    const folder = this.folder(taskId);
    mkdirSync(folder, { mode: 0o700 });
    secureNewWindowsDirectory(folder);
    mkdirSync(join(folder, 'source'), { mode: 0o700 });
    mkdirSync(join(folder, 'staged'), { mode: 0o700 });
    for (const item of sourceFiles) {
      writeNew(join(folder, 'source', ...item.file.split('/')), item.content);
      writeNew(join(folder, 'staged', ...item.file.split('/')), item.content);
    }
    writeNew(join(folder, 'manifest.json'), JSON.stringify({
      taskId, root: this.sourceRoot, files
    } satisfies Manifest));
    return files;
  }

  private checkedManifest(taskId: string, expectedFiles?: readonly string[]): Manifest {
    const folder = this.folder(taskId);
    if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) {
      throw new ProjectPreviewError('project_workspace_link_denied');
    }
    const manifest = manifestAt(folder);
    if (manifest.taskId !== taskId || resolve(manifest.root).toLowerCase() !== resolve(this.sourceRoot).toLowerCase() ||
      (expectedFiles && JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles))) {
      throw new ProjectPreviewError('project_manifest_identity_mismatch');
    }
    return manifest;
  }

  private readStage(taskId: string, mode: 'source' | 'staged', file: string): string {
    const filename = guardedFile(join(this.folder(taskId), mode), file);
    return textBytes(readFileSync(filename));
  }

  promptBundle(taskId: string, expectedFiles: readonly string[], mode: 'source' | 'staged' = 'staged'): string {
    const manifest = this.checkedManifest(taskId, expectedFiles);
    return manifest.files.map((file) =>
      JSON.stringify({ path: file, text: this.readStage(taskId, mode, file) })
    ).join('\n');
  }

  runtimeSeed(taskId: string, expectedFiles: readonly string[]): readonly RuntimeSeedFile[] {
    const manifest = this.checkedManifest(taskId, expectedFiles);
    const staged = join(this.folder(taskId), 'staged');
    for (const directory of [this.workspaceRoot, staged]) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectPreviewError('project_workspace_link_denied');
    }
    requireExactFiles(staged, manifest.files);
    const files = manifest.files.map(path => ({ path, text: this.readStage(taskId, 'staged', path) }));
    if (files.reduce((total, file) => total + Buffer.byteLength(file.text, 'utf8'), 0) > MAX_TOTAL_BYTES) {
      throw new ProjectPreviewError('project_bundle_too_large');
    }
    return files;
  }

  private verifySource(taskId: string, files: readonly string[]): boolean {
    return files.every((file) => {
      try {
        return textBytes(readFileSync(guardedFile(this.sourceRoot, file))) === this.readStage(taskId, 'source', file);
      } catch {
        return false;
      }
    });
  }

  /** Apply one exact-string replacement in an already imported file; model text cannot name a new target. */
  apply(taskId: string, raw: string, expectedFiles: readonly string[]): { path: string } {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROPOSAL_BYTES) {
      throw new ProjectPreviewError('project_proposal_too_large');
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProjectPreviewError('project_proposal_invalid');
    const proposal = data as Record<string, unknown>;
    if (Object.keys(proposal).some((key) => !['path', 'find', 'replace'].includes(key)) ||
      typeof proposal.path !== 'string' || typeof proposal.find !== 'string' ||
      typeof proposal.replace !== 'string' || proposal.find.length < 1 ||
      proposal.find.length > 5000 || proposal.replace.length > 5000 ||
      proposal.replace === proposal.find || proposal.find.includes('\u0000') ||
      proposal.replace.includes('\u0000')) {
      throw new ProjectPreviewError('project_proposal_schema_denied');
    }
    const manifest = this.checkedManifest(taskId, expectedFiles);
    if (!manifest.files.includes(proposal.path)) throw new ProjectPreviewError('project_proposal_path_denied');
    const base = this.readStage(taskId, 'source', proposal.path);
    const current = this.readStage(taskId, 'staged', proposal.path);
    const find = proposal.find;
    if (base !== current || !base.includes(find) || base.indexOf(find) !== base.lastIndexOf(find)) {
      throw new ProjectPreviewError('project_proposal_unanchored');
    }
    const next = base.replace(find, proposal.replace);
    if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) throw new ProjectPreviewError('project_proposal_output_too_large');
    if (proposal.path.endsWith('.json')) JSON.parse(next);
    const folder = this.folder(taskId);
    const target = guardedFile(join(folder, 'staged'), proposal.path);
    const temp = target + '.new';
    writeNew(join(folder, 'proposal.json'), JSON.stringify(proposal));
    writeNew(temp, next);
    renameSync(temp, target);
    return { path: proposal.path };
  }

  /** The reviewer may recommend rejecting a change; deterministic checks cannot be delegated to a model. */
  verify(taskId: string, rawReview: string, expectedFiles: readonly string[]): boolean {
    const folder = this.folder(taskId);
    const data: unknown = JSON.parse(rawReview);
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof (data as Record<string, unknown>).approved !== 'boolean') {
      throw new ProjectPreviewError('project_review_invalid');
    }
    const review = data as Record<string, unknown>;
    if (review.approved !== true || typeof review.reason !== 'string' ||
      review.reason.length > 1000 || !review.reason.trim()) {
      throw new ProjectPreviewError('project_review_rejected');
    }
    const p = JSON.parse(readFileSync(guardedFile(folder, 'proposal.json'), 'utf8')) as {
      path: string; find: string; replace: string;
    };
    const manifest = this.checkedManifest(taskId, expectedFiles);
    requireExactFiles(join(folder, 'source'), manifest.files);
    requireExactFiles(join(folder, 'staged'), manifest.files);
    if (!manifest.files.includes(p.path) || !this.verifySource(taskId, manifest.files)) {
      throw new ProjectPreviewError('project_source_changed');
    }
    for (const file of manifest.files) {
      const original = this.readStage(taskId, 'source', file);
      const expected = file === p.path ? original.replace(p.find, p.replace) : original;
      if (file === p.path && (!original.includes(p.find) ||
        original.indexOf(p.find) !== original.lastIndexOf(p.find))) {
        throw new ProjectPreviewError('project_proposal_unanchored');
      }
      if (this.readStage(taskId, 'staged', file) !== expected) {
        throw new ProjectPreviewError('project_staged_files_changed');
      }
    }
    writeNew(join(folder, 'review.json'), JSON.stringify({
      approved: true, reason: review.reason.slice(0, 1000), path: p.path
    }));
    return true;
  }

  preview(taskId: string, expectedFiles: readonly string[]): ProjectChangeView {
    const folder = this.folder(taskId);
    const manifest = this.checkedManifest(taskId, expectedFiles);
    requireExactFiles(join(folder, 'source'), manifest.files);
    requireExactFiles(join(folder, 'staged'), manifest.files);
    const proposal = JSON.parse(readFileSync(guardedFile(folder, 'proposal.json'), 'utf8')) as {
      path: string; find: string; replace: string;
    };
    const review = JSON.parse(readFileSync(guardedFile(folder, 'review.json'), 'utf8')) as {
      approved: boolean; reason: string; path: string;
    };
    if (review.approved !== true || review.path !== proposal.path ||
      !manifest.files.includes(proposal.path)) throw new ProjectPreviewError('project_review_not_verified');
    const before = this.readStage(taskId, 'source', proposal.path);
    const after = this.readStage(taskId, 'staged', proposal.path);
    const expected = before.replace(proposal.find, proposal.replace);
    if (after !== expected || !before.includes(proposal.find) ||
      before.indexOf(proposal.find) !== before.lastIndexOf(proposal.find)) {
      throw new ProjectPreviewError('project_staged_files_changed');
    }
    for (const file of manifest.files) {
      if (file !== proposal.path && this.readStage(taskId, 'source', file) !== this.readStage(taskId, 'staged', file)) {
        throw new ProjectPreviewError('project_other_files_changed');
      }
    }
    return {
      taskId, filename: proposal.path, before: before.slice(0, 6000), after: after.slice(0, 6000),
      reviewerNote: review.reason.slice(0, 1000),
      originalUnchanged: this.verifySource(taskId, manifest.files), verified: true, mergeEnabled: false
    };
  }
}

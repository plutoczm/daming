import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderPlugin, ProviderResult } from './plugins.ts';

/**
 * M5+ — Daming plugin framework (like Magpie's plugin/pluginrt): drop a plugin
 * directory in, it becomes available — no core code change. A plugin is:
 *
 *   plugins/<name>/plugin.json   manifest { id, name, version, kind, models?, capabilities?, description? }
 *   plugins/<name>/index.mjs     `export default { complete?, login?, checkin? }`
 *
 * kind: 'provider' (LLM/agent supply) | 'auth' (login/checkin) | 'agent'.
 * A provider plugin's `complete(bodyText)` returns an OpenAI-shaped JSON body and
 * is bridged into the gateway's ProviderPlugin so its models route like built-ins.
 */
export type PluginKind = 'provider' | 'agent' | 'auth';
export interface DamingPluginManifest {
  readonly id: string; readonly name: string; readonly version: string; readonly kind: PluginKind;
  readonly models?: readonly string[]; readonly capabilities?: readonly string[]; readonly description?: string;
}
export interface PluginChatResult { readonly status: number; readonly contentType: string; readonly bodyText: string }
export interface PluginContext { readonly dataDir?: string; readonly env: NodeJS.ProcessEnv }
export interface DamingPluginImpl {
  complete?(bodyText: string): Promise<PluginChatResult>;
  login?(ctx: PluginContext): Promise<unknown>;
  checkin?(ctx: PluginContext, accountId: string): Promise<{ kind: string; credits?: number }>;
}
export interface LoadedPlugin { readonly dir: string; readonly manifest: DamingPluginManifest; readonly impl: DamingPluginImpl }
export interface LoadReport { readonly loaded: readonly LoadedPlugin[]; readonly errors: readonly { dir: string; error: string }[] }

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function validateManifest(raw: unknown): DamingPluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error('plugin_manifest_invalid');
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error('plugin_id_invalid');
  if (typeof m.name !== 'string' || !m.name) throw new Error('plugin_name_invalid');
  if (typeof m.version !== 'string' || !m.version) throw new Error('plugin_version_invalid');
  if (!['provider', 'agent', 'auth'].includes(String(m.kind))) throw new Error('plugin_kind_invalid');
  if (m.models !== undefined && (!Array.isArray(m.models) || m.models.some((x) => typeof x !== 'string'))) throw new Error('plugin_models_invalid');
  return {
    id: m.id, name: m.name, version: m.version, kind: m.kind as PluginKind,
    ...(Array.isArray(m.models) ? { models: m.models as string[] } : {}),
    ...(Array.isArray(m.capabilities) ? { capabilities: m.capabilities as string[] } : {}),
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
  };
}

/** Load one plugin directory (plugin.json + index.mjs). */
export async function loadPluginDir(dir: string): Promise<LoadedPlugin> {
  const manifestPath = join(dir, 'plugin.json');
  const entryPath = join(dir, 'index.mjs');
  if (!existsSync(manifestPath) || !existsSync(entryPath)) throw new Error('plugin_missing_files');
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const mod = await import(pathToFileURL(entryPath).href) as { default?: unknown };
  const impl = (mod.default ?? {}) as DamingPluginImpl;
  if (manifest.kind === 'provider' && typeof impl.complete !== 'function') throw new Error('plugin_provider_missing_complete');
  return { dir, manifest, impl };
}

/** Load every plugin under a root dir (each subdir with plugin.json+index.mjs). Errors are collected, not thrown. */
export async function loadPlugins(root: string): Promise<LoadReport> {
  const loaded: LoadedPlugin[] = [];
  const errors: { dir: string; error: string }[] = [];
  const seen = new Set<string>();
  if (!existsSync(root)) return { loaded, errors };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'plugin.json'))) continue;
    if (pluginDisabled(dir)) continue;
    try {
      const p = await loadPluginDir(dir);
      if (seen.has(p.manifest.id)) { errors.push({ dir, error: 'plugin_duplicate_id:' + p.manifest.id }); continue; }
      seen.add(p.manifest.id); loaded.push(p);
    } catch (e) { errors.push({ dir, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { loaded, errors };
}

/** Bridge provider plugins into the gateway's ProviderPlugin contract. */
export function providerPluginsFromLoaded(loaded: readonly LoadedPlugin[]): ProviderPlugin[] {
  return loaded
    .filter((p) => p.manifest.kind === 'provider' && typeof p.impl.complete === 'function')
    .map((p) => ({
      id: p.manifest.id,
      models: p.manifest.models ?? [],
      complete: async (bodyText: string): Promise<ProviderResult> => {
        const r = await p.impl.complete!(bodyText);
        return { status: r.status, contentType: r.contentType, bodyText: r.bodyText };
      },
    }));
}

// ---- Plugin marketplace / manager (local install · enable/disable · list) ----

/** A plugin dir is disabled when it holds a `.disabled` marker. */
export function pluginDisabled(dir: string): boolean { return existsSync(join(dir, '.disabled')); }

export function setPluginEnabled(dir: string, enabled: boolean): void {
  const marker = join(dir, '.disabled');
  if (enabled) { if (existsSync(marker)) rmSync(marker); }
  else { writeFileSync(marker, ''); }
}

export interface PluginListItem { dir: string; name: string; enabled: boolean; manifest?: DamingPluginManifest; error?: string }

/** List every plugin dir under root (installed), with enabled state; invalid ones carry error. */
export function listPlugins(root: string): PluginListItem[] {
  const out: PluginListItem[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const mp = join(dir, 'plugin.json');
    if (!existsSync(mp)) continue;
    const enabled = !pluginDisabled(dir);
    try { out.push({ dir, name: basename(dir), enabled, manifest: validateManifest(JSON.parse(readFileSync(mp, 'utf8'))) }); }
    catch (e) { out.push({ dir, name: basename(dir), enabled, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}

/** Install a plugin by copying its directory under root (named by manifest id). Rejects if present. */
export function installPlugin(srcDir: string, root: string): string {
  if (!existsSync(join(srcDir, 'plugin.json')) || !existsSync(join(srcDir, 'index.mjs'))) throw new Error('plugin_missing_files');
  const manifest = validateManifest(JSON.parse(readFileSync(join(srcDir, 'plugin.json'), 'utf8')));
  const dest = join(root, manifest.id);
  if (existsSync(dest)) throw new Error('plugin_exists:' + manifest.id);
  mkdirSync(root, { recursive: true });
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}

export function removePlugin(root: string, id: string): void {
  const dest = join(root, id);
  if (!existsSync(dest)) throw new Error('plugin_not_found:' + id);
  rmSync(dest, { recursive: true, force: true });
}

/**
 * Compatibility shim: the original `web-browser-smoke.mjs` targeted the pre-v3
 * single-page board (Command Center, Codex approval panel, legacy platform section).
 * Those surfaces were replaced by the multi-page control plane, so the script kept
 * waiting for text that no reachable page renders.
 *
 * The current real-browser acceptance lives in `scripts/ui-v4-verify.mjs`
 * (shell, live SSE + fallback, execution graph, crew tree, focused dialogs,
 * responsive overflow, reduced motion, attribution). This file only forwards to it
 * so existing `pnpm test:web:browser` invocations keep working.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.warn('[deprecated] scripts/web-browser-smoke.mjs → running scripts/ui-v4-verify.mjs');
const script = join(dirname(fileURLToPath(import.meta.url)), 'ui-v4-verify.mjs');
const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
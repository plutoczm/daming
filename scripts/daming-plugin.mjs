#!/usr/bin/env node
/** Daming plugin manager CLI (ported from Magpie's plugin market capability).
 *  usage: daming-plugin list [dir] | install <srcDir> | enable <dir> | disable <dir> | remove <id>
 *  default plugins root: $DAMING_PLUGINS_DIR or ./plugins */
import { resolve } from 'node:path';
import { installPlugin, listPlugins, removePlugin, setPluginEnabled } from '../services/daming-gateway/src/index.ts';

const args = process.argv.slice(2);
const cmd = args[0];
const root = resolve(process.env.DAMING_PLUGINS_DIR || 'plugins');
try {
  switch (cmd) {
    case 'list': {
      const dir = resolve(args[1] || root);
      const items = listPlugins(dir);
      console.log(`plugins under ${dir}: (${items.length})`);
      for (const p of items) console.log(p.enabled ? '  ✓' : '  ✗', String(p.manifest?.id || p.name).padEnd(16), p.manifest?.kind || '', p.error ? 'ERR ' + p.error : (p.manifest?.models ? 'models=' + p.manifest.models.join(',') : ''));
      break;
    }
    case 'install': { const dest = installPlugin(resolve(args[1]), root); console.log('installed ->', dest); break; }
    case 'enable': { setPluginEnabled(resolve(args[1]), true); console.log('enabled', args[1]); break; }
    case 'disable': { setPluginEnabled(resolve(args[1]), false); console.log('disabled', args[1]); break; }
    case 'remove': { removePlugin(root, args[1]); console.log('removed', args[1]); break; }
    default: console.log('usage: daming-plugin list [dir] | install <srcDir> | enable <dir> | disable <dir> | remove <id>  (root=$DAMING_PLUGINS_DIR or ./plugins)');
  }
} catch (e) { console.error('error:', e instanceof Error ? e.message : String(e)); process.exit(1); }

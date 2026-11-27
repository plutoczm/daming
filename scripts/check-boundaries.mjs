// Adapted from Lancer's TypeScript AST boundary checks (MIT).
// Copyright (c) 2026 Matthew Lam. See scripts/LICENSE.lancer.
// This checks architecture during development; it is not a runtime sandbox.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const definitions = [
  ['packages/core', []],
  ['packages/ports', ['core']],
  ['packages/contracts', []],
  ['packages/source-protocol', []],
  ['packages/session-contracts', []],
  ['packages/store-sqlite', ['core','ports','governance']],
  ['packages/governance', ['core']],
  ['packages/planning', ['core']],
  ['packages/auditor', ['core']],
  ['packages/workers', []],
  ['packages/worker-process', ['workers']],
  ['packages/model-gateway', []],
  ['packages/connectors-lulu', []],
  ['packages/autoloop', []],
  ['apps/server', ['core','ports','contracts','source-protocol','session-contracts','store-sqlite','workers','model-gateway','worker-process','governance','planning','auditor','connectors-lulu','autoloop']],
  ['apps/web', ['contracts']],
  // Desktop shell supervises the Host; it holds no task/ledger state and imports no server/core.
  ['apps/desktop', []],
];
const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const inside = (dir, file) => {
  const rel=path.relative(dir,file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+path.sep));
};
const packageName = value => value.startsWith('@') ? value.split('/').slice(0,2).join('/') : value.split('/')[0];
function filesUnder(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const file=path.join(dir,entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source symlink/junction must not bypass package ownership: '+file);
    if (entry.isDirectory()) return entry.name==='node_modules' ? [] : filesUnder(file);
    return extensions.test(file) ? [file] : [];
  });
}
function exportTarget(value) {
  if (typeof value==='string') return value;
  if (value && typeof value==='object') return exportTarget(value.import ?? value.default ?? value.types);
}

/** Return every rejected dependency, including unresolved edges. */
export function checkBoundaries(projectRoot) {
  const root=realpathSync(projectRoot);
  const failures=[];
  let checkedFiles=0;
  const service=path.join(root,'services/model-gateway-go');
  const vendoredMagpie=path.join(root,'services/damingd');
  if(existsSync(service)&&!existsSync(vendoredMagpie)){
    const allowedRoots=new Set(['bufio','bytes','context','crypto','encoding','errors','flag','fmt','io','log','net','os','path','regexp','runtime','sort','strconv','strings','sync','syscall','time','unicode','unsafe']);
    const walkGo=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
      const f=path.join(dir,e.name);if(e.isSymbolicLink()){failures.push('Go source symlink forbidden');return [];}
      return e.isDirectory()?walkGo(f):e.name.endsWith('.go')&&!e.name.endsWith('_test.go')?[f]:[];
    });
    for(const f of walkGo(service)){
      const source=readFileSync(f,'utf8');
      const imports=[...source.matchAll(/import\s*(?:\(([\s\S]*?)\)|(?:[\w.]+\s+)?"([^"]+)")/g)].flatMap(m=>m[2]?[m[2]]:[...(m[1]??'').matchAll(/"([^"]+)"/g)].map(x=>x[1]));
      for(const dep of imports){
        const own=['github.com/yetone/magpie/internal/engine','github.com/yetone/magpie/internal/stream'].includes(dep);
        if(!own&&!allowedRoots.has(dep.split('/')[0]))failures.push('Go gateway forbidden dependency: '+dep);
        if(dep==='os/exec'&&path.relative(service,f).replaceAll('\\','/')!=='internal/engine/lifecycle.go')failures.push('Go process launch must stay in owned lifecycle');
      }
    }
  }
  const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
  if (config.error) return {failures:[ts.flattenDiagnosticMessageText(config.error.messageText,'\n')],checkedFiles};
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
  // parseJsonConfigFileContent may report no input files for intentionally incomplete fixtures.
  for (const error of parsed.errors.filter(error=>error.code!==18003)) failures.push(ts.flattenDiagnosticMessageText(error.messageText,'\n'));
  const areas=[];
  for (const [relative,allowed] of definitions) {
    const directory=path.join(root,relative), src=path.join(directory,'src');
    const manifest=path.join(directory,'package.json');
    if (!existsSync(manifest) || !existsSync(path.join(src,'index.ts'))) {
      failures.push(relative+': missing package.json or src/index.ts'); continue;
    }
    if (!inside(root,realpathSync(directory)) || !inside(realpathSync(directory),realpathSync(src))) {
      failures.push(relative+': package source escapes its owner via symlink/junction'); continue;
    }
    const pkg=JSON.parse(readFileSync(manifest,'utf8'));
    const shortName=path.basename(directory);
    if (pkg.name!=='@daming/'+shortName) failures.push(relative+': unexpected package name');
    areas.push({relative,directory:realpathSync(directory),src:realpathSync(src),pkg,shortName,allowed:new Set(allowed)});
  }
  for (const group of ['apps','packages']) {
    if (!existsSync(path.join(root,group))) continue;
    for (const entry of readdirSync(path.join(root,group),{withFileTypes:true})) {
      if (entry.isDirectory() && !definitions.some(([dir])=>dir===group+'/'+entry.name)) failures.push(group+'/'+entry.name+': missing architecture policy');
    }
  }
  const owner=file=>areas.find(area=>inside(area.src,file));
  const cache=ts.createModuleResolutionCache(root,file=>ts.sys.useCaseSensitiveFileNames?file:file.toLowerCase(),parsed.options);
  for (const area of areas) {
    let sources;
    try { sources=filesUnder(area.src); } catch (error) { failures.push(error.message); continue; }
    for (const original of sources) {
    const file=realpathSync(original);
    if (!inside(area.src,file)) { failures.push(original+': source escapes package via symlink'); continue; }
    checkedFiles++;
    const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const fail=(node,message)=>{
      const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
      failures.push(path.relative(root,file).split(path.sep).join('/')+':'+line+': '+message);
    };
    // References are not visited as import AST nodes; keep dependencies explicit.
    for (const reference of [...source.referencedFiles,...source.typeReferenceDirectives]) {
      fail(source,'Triple-slash path/type references are forbidden; use checked type imports: '+reference.fileName);
    }
    const inspect=(expression,typeOnly=false)=>{
      if (!expression || !ts.isStringLiteralLike(expression)) {
        fail(expression??source,'Computed module loading cannot be checked'); return;
      }
      const specifier=expression.text;
      if (isBuiltin(specifier) || specifier.startsWith('node:')) {
        const builtin=specifier.replace(/^node:/,'');
        if (!['server','store-sqlite','worker-process','governance','autoloop','desktop'].includes(area.shortName) &&
            !(area.shortName==='model-gateway'&&['http','net','crypto'].includes(builtin)) &&
            !(area.shortName==='connectors-lulu'&&builtin==='crypto')) fail(expression,'Node dependency is forbidden: '+specifier);
        return;
      }
      const resolved=ts.resolveModuleName(specifier,file,parsed.options,ts.sys,cache).resolvedModule;
      if (!resolved || !existsSync(resolved.resolvedFileName)) {
        fail(expression,'Unresolved dependency: '+specifier); return;
      }
      const target=realpathSync(resolved.resolvedFileName);
      const targetArea=owner(target);
      if (targetArea===area) return;
      if (!targetArea) {
        const external=(area.shortName==='web' && ['react','react-dom'].includes(packageName(specifier))) ||
          (area.shortName==='server' && path.relative(area.src,file)==='feishu-long-connection.ts' &&
            specifier==='@larksuiteoapi/node-sdk');
        if (!external || !area.pkg.dependencies?.[packageName(specifier)]) fail(expression,'Dependency outside permitted source: '+specifier);
        return;
      }
      if (!area.allowed.has(targetArea.shortName)) {
        fail(expression,'Forbidden dependency on '+targetArea.relative); return;
      }
      if (area.shortName==='ports' && !typeOnly) {
        fail(expression,'Ports may only use whole-statement type imports/exports'); return;
      }
      const name=targetArea.pkg.name;
      const key=specifier===name ? '.' : specifier.startsWith(name+'/') ? './'+specifier.slice(name.length+1) : undefined;
      const entry=key && exportTarget(targetArea.pkg.exports?.[key]);
      if (!entry || !existsSync(path.resolve(targetArea.directory,entry)) || realpathSync(path.resolve(targetArea.directory,entry))!==target) {
        fail(expression,'Cross-package dependency must use a public export: '+specifier); return;
      }
      if (!area.pkg.dependencies?.[name]) fail(expression,'Undeclared workspace dependency: '+name);
    };
    const visit=node=>{
      if (ts.isImportDeclaration(node)) {
        inspect(node.moduleSpecifier,!!node.importClause?.isTypeOnly);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        inspect(node.moduleSpecifier,node.isTypeOnly);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        inspect(node.argument.literal,true);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        inspect(node.moduleReference.expression,node.isTypeOnly);
      } else if (ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression)&&node.expression.text==='require'))) {
        inspect(node.arguments[0]);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='glob' && ts.isMetaProperty(node.expression.expression)) {
        fail(node,'import.meta.glob cannot be checked');
      } else if (ts.isNewExpression(node) && ((ts.isIdentifier(node.expression)&&['Worker','SharedWorker'].includes(node.expression.text)) || (ts.isPropertyAccessExpression(node.expression)&&['Worker','SharedWorker'].includes(node.expression.name.text)))) {
        const url=node.arguments?.[0];
        const base=url&&ts.isNewExpression(url)?url.arguments?.[1]:undefined;
        if (url&&ts.isNewExpression(url)&&ts.isIdentifier(url.expression)&&url.expression.text==='URL'&&base&&ts.isPropertyAccessExpression(base)&&base.name.text==='url'&&ts.isMetaProperty(base.expression)) inspect(url.arguments?.[0]);
        else fail(node,'Worker entry must use a checkable URL');
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
    }
  }
  return {failures,checkedFiles};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=checkBoundaries(fileURLToPath(new URL('../',import.meta.url)));
  if (result.failures.length) { console.error(result.failures.join('\n')); process.exitCode=1; }
  else console.log('Architecture boundaries passed ('+result.checkedFiles+' source files).');
}

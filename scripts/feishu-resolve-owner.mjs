/**
 * Resolve the Feishu project-owner `open_id` (and prove the app credentials work)
 * using ONLY the custom-app App ID / App Secret. Read-only: it never sends a
 * message and never stores the App Secret.
 *
 * Usage:
 *   node -X utf8 scripts/feishu-resolve-owner.mjs \
 *     --app-id=cli_xxx --app-secret=xxx [--email=me@corp.com] [--mobile=13800000000]
 *
 * Env fallback: FEISHU_APP_ID / FEISHU_APP_SECRET.
 *
 * Strategy (first success wins, all attempts are logged):
 *   1) email/mobile -> POST /open-apis/contact/v3/users/batch_get_id
 *   2) root-department listing -> GET /open-apis/contact/v3/users/find_by_department?department_id=0
 *   3) app contact scopes -> GET /open-apis/contact/v3/scopes  (what the app is allowed to read)
 *
 * Output: .cache/verification/feishu-owner-resolve.json  (open_id + masked diagnostics only)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const appId = (arg('app-id', process.env.FEISHU_APP_ID) || '').trim();
const appSecret = (arg('app-secret', process.env.FEISHU_APP_SECRET) || '').trim();
const email = (arg('email', process.env.FEISHU_OWNER_EMAIL) || '').trim();
const mobile = (arg('mobile', process.env.FEISHU_OWNER_MOBILE) || '').trim();

if (!appId || !appSecret) {
  console.error('missing --app-id / --app-secret (or FEISHU_APP_ID / FEISHU_APP_SECRET)');
  process.exit(2);
}
const mask = (value) => (!value ? '' : value.length <= 8 ? '****' : value.slice(0, 4) + '****' + value.slice(-4));

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function get(path, token) {
  const res = await fetch(BASE + path, { headers: { authorization: 'Bearer ' + token } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const proof = {
  observedAt: new Date().toISOString(),
  base: BASE,
  appIdMasked: mask(appId),
  secretPresent: Boolean(appSecret),
  attempts: [],
  ownerOpenId: null,
  candidates: [],
  ok: false,
};

try {
  const tokenRes = await post('/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId, app_secret: appSecret,
  });
  proof.token = { status: tokenRes.status, code: tokenRes.json.code, msg: tokenRes.json.msg };
  const token = tokenRes.json.tenant_access_token;
  if (!token) {
    proof.error = 'tenant_access_token_failed';
    throw new Error('no tenant_access_token (check App ID/Secret and that the app is enabled)');
  }
  proof.token.expireSeconds = tokenRes.json.expire;
  proof.tokenOk = true;

  // 0) tenant info (proves org context without extra scope)
  try {
    const tenant = await get('/open-apis/tenant/v2/tenant/query', token);
    proof.attempts.push({ step: 'tenant/query', status: tenant.status, code: tenant.json.code, msg: tenant.json.msg });
    if (tenant.json.code === 0) {
      proof.tenant = { name: tenant.json.data?.tenant?.name, tenantKey: tenant.json.data?.tenant?.tenant_key };
    }
  } catch (error) { proof.attempts.push({ step: 'tenant/query', error: String(error?.message || error) }); }

  // 1) direct lookup by email / mobile
  for (const [kind, value, field] of [['email', email, 'emails'], ['mobile', mobile, 'mobiles']]) {
    if (!value) continue;
    const lookup = await post('/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', { [field]: [value] }, token);
    proof.attempts.push({ step: 'batch_get_id/' + kind, status: lookup.status, code: lookup.json.code, msg: lookup.json.msg });
    const list = lookup.json.data?.user_list ?? [];
    for (const item of list) {
      if (item.user_id) proof.candidates.push({ source: kind, openId: item.user_id, matched: true });
    }
  }

  // 2) root department listing (owner is usually in the org root department)
  if (!proof.candidates.length) {
    const list = await get('/open-apis/contact/v3/users/find_by_department?department_id=0&user_id_type=open_id&page_size=50', token);
    proof.attempts.push({ step: 'users/find_by_department(0)', status: list.status, code: list.json.code, msg: list.json.msg });
    for (const user of list.json.data?.items ?? []) {
      if (user.open_id) proof.candidates.push({
        source: 'root_department', openId: user.open_id, name: user.name, email: user.email, jobTitle: user.job_title,
      });
    }
  }

  // 3) what contact scopes the app actually holds
  const scopes = await get('/open-apis/contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id', token);
  proof.attempts.push({ step: 'contact/v3/scopes', status: scopes.status, code: scopes.json.code, msg: scopes.json.msg });
  if (scopes.json.code === 0) {
    proof.scopes = {
      userIds: scopes.json.data?.user_ids?.length ?? 0,
      departmentIds: scopes.json.data?.department_ids?.length ?? 0,
    };
    // 4) the app is scoped to specific users -> resolve each to a full open_id record
    for (const userId of scopes.json.data?.user_ids ?? []) {
      const detail = await get('/open-apis/contact/v3/users/' + encodeURIComponent(userId) + '?user_id_type=open_id', token);
      proof.attempts.push({ step: 'users/' + userId, status: detail.status, code: detail.json.code, msg: detail.json.msg });
      const user = detail.json.data?.user;
      if (detail.json.code === 0 && user?.open_id) {
        proof.candidates.push({
          source: 'contact_scope', openId: user.open_id, name: user.name,
          enName: user.en_name, email: user.email, mobile: user.mobile ? mask(user.mobile) : undefined,
          jobTitle: user.job_title, status: user.status,
        });
      } else {
        proof.candidates.push({ source: 'contact_scope', openId: userId, name: '(detail not readable; open_id itself is the user id)' });
      }
    }
  }

  if (proof.candidates.length === 1) {
    proof.ownerOpenId = proof.candidates[0].openId;
  }
  proof.ok = proof.candidates.length > 0;
  if (!proof.ok) {
    proof.hint = 'No user visible to the app. Either (a) grant contact:user.base:readonly + contact:user.employee_id:readonly and put the owner in a department the app can see, or (b) rerun with --email/--mobile of the owner, or (c) read open_id from a real card callback (event.operator.open_id).';
  }
} catch (error) {
  proof.error = String(error?.message || error).slice(0, 200);
  if (!proof.tokenOk) proof.ok = false;
}

mkdirSync(resolve('.cache/verification'), { recursive: true });
writeFileSync(resolve('.cache/verification/feishu-owner-resolve.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
if (!proof.ok) process.exitCode = 1;

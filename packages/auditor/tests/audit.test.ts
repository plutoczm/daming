import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditAssignment } from '../src/index.ts';
const plan:any={steps:[{stepId:'s',contract:{checks:[{id:'c',version:1,artifactId:'file',kind:'json_equals',expected:{ok:true}}]}}]};
const a:any={assignmentId:'a',sessionId:'s',taskId:'t',runId:'r',attemptId:'try',planVersion:1,contractVersion:1,stepAttempt:1,stepId:'s',delivery:{status:'completed',artifacts:{file:{ok:true}}}};
const receipt:any={assignmentId:'a',sessionId:'s',taskId:'t',runId:'r',attemptId:'try',planVersion:1,contractVersion:1,artifactVersion:1,checkId:'c',checkVersion:1,checkerId:'host:c',status:'pass'};
test('auditor requires trusted evidence and checks actual content, not worker PASS',()=>{assert.equal(auditAssignment(plan,a,[receipt]).verdict,'pass');assert.equal(auditAssignment(plan,a,[]).verdict,'needs_human');assert.equal(auditAssignment(plan,a,[{...receipt,checkerId:'worker:c'}]).verdict,'needs_human');assert.equal(auditAssignment(plan,{...a,delivery:{...a.delivery,artifacts:{file:{ok:false}}}},[receipt]).verdict,'fail');});
test('failed trusted test cannot pass and stale artifact version needs human',()=>{assert.equal(auditAssignment(plan,a,[{...receipt,status:'fail'}]).verdict,'fail');assert.equal(auditAssignment(plan,a,[{...receipt,artifactVersion:2}]).verdict,'needs_human');});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';
test('route policy lists hard failures without silently authorizing fallback',()=>{
 const fn=(api as unknown as {evaluateRoute:(a:unknown,b:unknown)=>{allowed:boolean;reasons:string[]}}).evaluateRoute;assert.equal(typeof fn,'function');
 const request={requestId:'r',sessionId:'s',protocol:'responses',model:'fixture-model',template:'text',route:{mode:'native',provider:'fixture',accountRef:'fixture-a'},dataScope:'synthetic',maxInputTokens:128,maxOutputTokens:128};
 const policy={available:true,protocols:['responses'],streaming:true,tools:true,approvedAccounts:['fixture-a'],dataScopes:['synthetic'],quoteMinor:1200};
 assert.equal(fn(request,policy).allowed,true);
 const denied=fn(request,{...policy,available:false,protocols:[],streaming:false,approvedAccounts:[],quoteMinor:null,binding:'foreign',contextBinding:'foreign'});
 assert.equal(denied.allowed,false);for(const reason of ['unavailable','protocol','streaming','account','unknown_price','session_binding','context_binding'])assert.ok(denied.reasons.includes(reason));
 assert.equal('fallback' in denied,false);
});

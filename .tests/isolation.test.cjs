const test = require('node:test');
const assert = require('node:assert/strict');
const {
  confirmIsolation,
  confirmGeneric,
  invalidateStaleActions,
  runIsolation,
  applyItemOutcomes,
  pendingAssetIds,
  isReadyToRun,
  scopeFingerprint,
  roleCanApprove,
  roleCanSeeSensitive,
  canExecuteGeneric,
} = require('./build/isolation');
const { isolateAssetsByItem } = require('./build/executor');

const NOW = '2026-10-06T08:00:00.000Z';

function makeAction(overrides = {}) {
  return {
    id: 'act-1',
    title: '隔离异常网关节点',
    kind: 'isolate',
    sensitive: true,
    status: 'pending',
    version: 3,
    approvals: [],
    isolationRecords: [],
    ...overrides,
  };
}

const scope = { severity: 'critical', affected: ['api-gateway', 'customer-portal', 'audit-log'] };

function lock(action, roles = ['analyst', 'responder'], lockScope = scope) {
  let current = action;
  roles.forEach((role, index) => {
    const res = confirmIsolation({
      ...lockScope, action: current, role, expectedVersion: current.version, demoMode: false,
      now: new Date(Date.parse(NOW) + index * 3000).toISOString(),
    });
    assert.equal(res.ok, true);
    current = res.action;
  });
  return current;
}

test('逐资产落地：单项失败不回滚整批，其余资产照常隔离', () => {
  const action = lock(makeAction());
  const res = runIsolation({
    action, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (assetId) => (assetId === 'audit-log'
      ? { ok: false, error: '接口超时' }
      : { ok: true }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.succeeded.sort(), ['api-gateway', 'customer-portal']);
  assert.deepEqual(res.failed, ['audit-log']);
  assert.equal(res.action.status, 'partial');
  const failed = res.action.isolationRecords.find((r) => r.assetId === 'audit-log');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, '接口超时');
  assert.equal(failed.attempts, 1);
});

test('失败后保留未完成记录；重试不再查询/执行已成功资产，只补齐失败项', () => {
  const action = lock(makeAction());
  const first = runIsolation({
    action, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (assetId) => (assetId === 'audit-log' ? { ok: false, error: '超时' } : { ok: true }),
  });
  assert.equal(first.action.status, 'partial');
  assert.deepEqual(pendingAssetIds(first.action), ['audit-log']);

  const queried = [];
  const retry = runIsolation({
    action: first.action, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (assetId) => { queried.push(assetId); return { ok: true }; },
  });
  assert.deepEqual(queried, ['audit-log']);
  assert.deepEqual(retry.ran, ['audit-log']);
  assert.equal(retry.action.status, 'executed');
  const gateway = retry.action.isolationRecords.find((r) => r.assetId === 'api-gateway');
  assert.equal(gateway.attempts, 1);
});

test('乐观版本：几秒内两人确认同一动作，持过期版本者不入库也不计批准人数', () => {
  const action = makeAction(); // version 3
  // 第一确认人正常提交，版本变为 4
  const first = confirmIsolation({
    ...scope, action, role: 'analyst', expectedVersion: 3, demoMode: false, now: NOW,
  });
  assert.equal(first.ok, true);
  assert.equal(first.action.version, 4);
  assert.equal(first.action.approvals.length, 1);

  // 第二确认人基于渲染时拿到的旧版本 3 提交
  const stale = confirmIsolation({
    ...scope, action: first.action, role: 'responder', expectedVersion: 3, demoMode: false, now: NOW,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'version-stale');
  assert.equal(first.action.approvals.length, 1); // 未计入
  assert.equal(first.action.status, 'pending'); // 状态未被推进
});

test('敏感级别变化：按旧范围批准待执行的动作立即失效退回待确认', () => {
  const action = lock(makeAction());
  assert.equal(action.status, 'approved');
  const [invalidated] = invalidateStaleActions([action], { severity: 'high', affected: scope.affected });
  assert.equal(invalidated.status, 'pending');
  assert.equal(invalidated.approvals.length, 0);
  assert.equal(invalidated.lockedScope, undefined);
  assert.equal(invalidated.lockedAssets, undefined);
  assert.ok(invalidated.version > action.version);
  // 未成功记录标记失效；重新批准前无法执行
  const run = runIsolation({
    action: invalidated, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: () => { throw new Error('不应被调用'); },
  });
  assert.equal(run.ok, false);
  assert.equal(run.reason, 'not-approved');
});

test('受影响资产变化同样失效；已全部执行完成的动作不受影响', () => {
  const action = lock(makeAction());
  const done = runIsolation({
    action, role: 'responder', demoMode: false, now: NOW, isolateAsset: () => ({ ok: true }),
  }).action;
  assert.equal(done.status, 'executed');
  const [stays] = invalidateStaleActions([done], { severity: 'critical', affected: [...scope.affected, 'new-host'] });
  assert.equal(stays.status, 'executed');
  assert.deepEqual(stays.approvals.map((a) => a.role), ['analyst', 'responder']);

  const partial = runIsolation({
    action: lock(makeAction({ id: 'act-2' })), role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (id) => (id === 'audit-log' ? { ok: false, error: 'x' } : { ok: true }),
  }).action;
  const [reset] = invalidateStaleActions([partial], { severity: 'critical', affected: [...scope.affected, 'new-host'] });
  assert.equal(reset.status, 'pending');
  // 已成功资产的记录保留，失败记录转为失效留痕
  const gateway = reset.isolationRecords.find((r) => r.assetId === 'api-gateway');
  assert.equal(gateway.status, 'success');
  const audit = reset.isolationRecords.find((r) => r.assetId === 'audit-log');
  assert.equal(audit.status, 'invalidated');
});

test('失效后按新范围重新确认：范围按新清单锁定，不重建已成功资产的记录', () => {
  const action = lock(makeAction());
  const partial = runIsolation({
    action, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (id) => (id === 'audit-log' ? { ok: false, error: 'x' } : { ok: true }),
  }).action;
  const newScope = { severity: 'critical', affected: ['api-gateway', 'customer-portal', 'audit-log', 'new-host'] };
  const [invalidated] = invalidateStaleActions([partial], newScope);
  const relocked = lock(invalidated, ['analyst', 'responder'], newScope);
  assert.deepEqual(relocked.lockedAssets.sort(), newScope.affected.slice().sort());
  // api-gateway 已有成功记录，不新建；只新增 audit-log 与 new-host 两条待执行
  const gatewayRecords = relocked.isolationRecords.filter((r) => r.assetId === 'api-gateway');
  assert.equal(gatewayRecords.length, 1);
  assert.equal(gatewayRecords[0].status, 'success');
  const newHost = relocked.isolationRecords.filter((r) => r.assetId === 'new-host');
  assert.equal(newHost.length, 1);
  assert.equal(newHost[0].status, 'pending');
  // 重试只跑未成功项，补齐后整批完成
  const retry = runIsolation({
    action: relocked, role: 'responder', demoMode: false, now: NOW, isolateAsset: () => ({ ok: true }),
  });
  assert.deepEqual(retry.ran.sort(), ['audit-log', 'new-host']);
  assert.equal(retry.action.status, 'executed');
});

test('范围锁定于批准时刻：批准后新加资产不进入这一批', () => {
  const action = lock(makeAction());
  // 事后通过逐项记账混入一条范围外记录，执行器不得处理它
  const withExtra = applyItemOutcomes(action, [{ assetId: 'late-host', status: 'pending' }], NOW);
  const res = runIsolation({
    action: withExtra, role: 'responder', demoMode: false, now: NOW,
    isolateAsset: (id) => (id === 'late-host' ? { ok: false, error: '不该执行' } : { ok: true }),
  });
  assert.ok(!res.ran.includes('late-host'));
  assert.equal(res.action.status, 'executed');
});

test('敏感动作内容不下发给无审批权限角色；执行前无隔离记录直接拒绝', () => {
  assert.equal(roleCanApprove('viewer'), false);
  assert.equal(roleCanSeeSensitive({ sensitive: true }, 'viewer'), false);
  assert.equal(roleCanSeeSensitive({ sensitive: true }, 'analyst'), true);

  const asViewer = confirmIsolation({
    ...scope, action: makeAction(), role: 'viewer', expectedVersion: 3, demoMode: false, now: NOW,
  });
  assert.equal(asViewer.ok, false);
  assert.equal(asViewer.reason, 'sensitive-role-not-allowed');

  // 未批准 → 没有隔离记录 → 执行直接拒绝
  const run = runIsolation({
    action: makeAction(), role: 'responder', demoMode: false, now: NOW,
    isolateAsset: () => ({ ok: true }),
  });
  assert.equal(run.ok, false);
  assert.equal(run.reason, 'not-approved');
});

test('同一角色不能重复确认；演示模式冻结一切写操作', () => {
  const action = makeAction();
  const first = confirmIsolation({ ...scope, action, role: 'analyst', expectedVersion: 3, demoMode: false, now: NOW });
  const dup = confirmIsolation({ ...scope, action: first.action, role: 'analyst', expectedVersion: 4, demoMode: false, now: NOW });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate-confirmation');

  const demo = confirmIsolation({ ...scope, action: first.action, role: 'responder', expectedVersion: 4, demoMode: true, now: NOW });
  assert.equal(demo.ok, false);
  assert.equal(demo.reason, 'demo-readonly');
});

test('每次有效确认都推进版本并留痕；范围指纹覆盖级别与资产', () => {
  const action = lock(makeAction());
  assert.equal(action.version, 5);
  assert.deepEqual(action.approvals.map((a) => a.version), [3, 4]);
  assert.equal(action.lockedScope, scopeFingerprint(scope));
  assert.notEqual(scopeFingerprint(scope), scopeFingerprint({ ...scope, severity: 'high' }));
  assert.notEqual(scopeFingerprint(scope), scopeFingerprint({ ...scope, affected: [...scope.affected, 'x'] }));
});

test('执行器逐资产独立：异常被吞成单项失败，调用方拿到完整结果', async () => {
  const endpoint = {
    isolate: async (id) => { if (id === 'b') throw new Error('网络错误'); },
    status: async (id) => (id === 'b' ? 'reachable' : 'isolated'),
  };
  const outcomes = await isolateAssetsByItem({ endpoint, assetIds: ['a', 'b', 'c'] });
  const byId = Object.fromEntries(outcomes.map((o) => [o.assetId, o]));
  assert.equal(byId.a.status, 'success');
  assert.equal(byId.b.status, 'failed');
  assert.match(byId.b.error, /网络错误/);
  assert.equal(byId.c.status, 'success');
});

test('非隔离动作：通用双人确认与执行校验一致', () => {
  const action = makeAction({ kind: 'block', sensitive: false });
  assert.equal(canExecuteGeneric(action, 'responder', false), 'not-approved');
  const a = confirmGeneric({ ...scope, action, role: 'analyst', expectedVersion: 3, demoMode: false, now: NOW }).action;
  const b = confirmGeneric({ ...scope, action: a, role: 'responder', expectedVersion: 4, demoMode: false, now: NOW }).action;
  assert.equal(b.status, 'approved');
  assert.equal(canExecuteGeneric(b, 'viewer', false), 'role-not-allowed');
  assert.equal(canExecuteGeneric(b, 'responder', true), 'demo-readonly');
});

test('isReadyToRun 仅在批准且存在未成功记录时为真', () => {
  assert.equal(isReadyToRun(makeAction()), false);
  const locked = lock(makeAction());
  assert.equal(isReadyToRun(locked), true);
  const done = runIsolation({ action: locked, role: 'responder', demoMode: false, now: NOW, isolateAsset: () => ({ ok: true }) }).action;
  assert.equal(isReadyToRun(done), false);
});

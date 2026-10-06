// 隔离动作核心领域逻辑（纯函数，不依赖 React/Zustand，便于单测与推演）
//
// 覆盖的业务规则：
// 1. 隔离动作按受影响资产逐项落地：每个资产一条独立的隔离记录，单项失败不回滚整批。
// 2. 资产、处置动作、审批记录合并在同一个动作视图内查看，每个隔离结果单独记账。
// 3. 失败后保留未完成记录；重试只执行未成功的资产，已隔离成功的资产不再查询、不再执行。
// 4. 确认携带动作版本号：版本过期（与当前版本不一致）的确认不入库、不计批准人数、不改任何状态。
// 5. 敏感级别或受影响资产变化时，按旧范围批准、尚待执行的动作立即失效，退回待确认。
// 6. 敏感动作内容不向无审批权限的角色下发；执行前没有对应隔离记录的动作直接拒绝。
// 7. 隔离范围在批准（达到确认门槛）时锁定，事后新加的资产不进入这一批。

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'partial' | 'executed';
export type Severity = 'medium' | 'high' | 'critical';
export type IsolationStatus = 'pending' | 'success' | 'failed' | 'invalidated';

/** 具备审批权限的角色；敏感动作内容只下发给这些角色（viewer 永远无权） */
export const APPROVER_ROLES: Role[] = ['analyst', 'responder', 'legal'];

/** 高优先级隔离动作需要两名不同角色先后确认 */
export const REQUIRED_CONFIRMATIONS = 2;

export interface ApprovalEntry {
  role: Role;
  at: string;
  /** 该次确认针对的动作版本，用于事后审计 */
  version: number;
}

export interface IsolationRecord {
  id: string;
  assetId: string;
  status: IsolationStatus;
  attempts: number;
  lastError?: string;
  lastAt?: string;
}

export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  sensitive?: boolean;
  status: ActionStatus;
  /** 乐观并发版本：每次有效确认 +1；范围失效重建版本 +1。过期确认据此拒绝。 */
  version: number;
  /** 批准时锁定的范围指纹（敏感级别 + 资产清单），用于判定“按旧范围批准” */
  lockedScope?: string;
  /** 达到确认门槛那一刻锁定的资产清单；事后新增资产不在其中 */
  lockedAssets?: string[];
  approvals: ApprovalEntry[];
  /** 逐资产的隔离结果记录，与动作、审批同体 */
  isolationRecords: IsolationRecord[];
}

export interface IncidentScope {
  severity: Severity;
  affected: string[];
}

export type RejectReason =
  | 'not-found'
  | 'demo-readonly'
  | 'role-not-allowed'
  | 'sensitive-role-not-allowed'
  | 'duplicate-confirmation'
  | 'version-stale'
  | 'not-approved'
  | 'already-completed'
  | 'no-isolation-records';

export interface ConfirmContext extends IncidentScope {
  action: ResponseAction;
  role: Role;
  /** 提交者持有的动作版本；与当前 version 不一致即过期 */
  expectedVersion: number;
  demoMode: boolean;
  now: string;
}

export type ConfirmResult =
  | { ok: true; action: ResponseAction; justLocked: boolean }
  | { ok: false; reason: RejectReason };

export interface RunContext {
  action: ResponseAction;
  role: Role;
  demoMode: boolean;
  now: string;
  /** 单项执行器：对单个资产尝试隔离，返回成功或失败原因 */
  isolateAsset: (assetId: string) => { ok: boolean; error?: string };
}

export type RunResult =
  | { ok: true; action: ResponseAction; ran: string[]; succeeded: string[]; failed: string[] }
  | { ok: false; reason: RejectReason };

let recordSeq = 0;
function newRecordId(): string {
  recordSeq += 1;
  return `iso-${Date.now().toString(36)}-${recordSeq}`;
}

/** 范围指纹：敏感级别 + 去重排序后的资产清单 */
export function scopeFingerprint(scope: IncidentScope): string {
  return `${scope.severity}|${Array.from(new Set(scope.affected)).sort().join(',')}`;
}

export function roleCanApprove(role: Role): boolean {
  return APPROVER_ROLES.includes(role);
}

/** 敏感动作内容是否可下发给该角色 */
export function roleCanSeeSensitive(action: Pick<ResponseAction, 'sensitive'>, role: Role): boolean {
  return !action.sensitive || roleCanApprove(role);
}

function buildRecords(assets: string[]): IsolationRecord[] {
  return assets.map((assetId) => ({ id: newRecordId(), assetId, status: 'pending', attempts: 0 }));
}

/**
 * 处理一次隔离动作确认（双人确认 + 乐观版本控制）。
 * 过期版本、重复角色、无权限、只读演示一律拒绝，且不产生任何状态变更。
 */
export function confirmIsolation(ctx: ConfirmContext): ConfirmResult {
  const { action, role, expectedVersion, demoMode, now } = ctx;
  if (demoMode) return { ok: false, reason: 'demo-readonly' };
  if (action.sensitive && !roleCanApprove(role)) return { ok: false, reason: 'sensitive-role-not-allowed' };
  if (!roleCanApprove(role)) return { ok: false, reason: 'role-not-allowed' };
  if (expectedVersion !== action.version) return { ok: false, reason: 'version-stale' };
  if (action.approvals.some((entry) => entry.role === role)) return { ok: false, reason: 'duplicate-confirmation' };

  const approvals = [...action.approvals, { role, at: now, version: action.version }];
  let status: ActionStatus = action.status;
  let lockedScope = action.lockedScope;
  let lockedAssets = action.lockedAssets;
  let isolationRecords = action.isolationRecords;
  let justLocked = false;

  // 达到确认门槛的瞬间锁定范围：敏感级别 + 当时的受影响资产
  if (approvals.length >= REQUIRED_CONFIRMATIONS) {
    const distinctRoles = new Set(approvals.map((entry) => entry.role));
    if (distinctRoles.size >= REQUIRED_CONFIRMATIONS && action.status !== 'approved' && action.status !== 'partial') {
      status = 'approved';
      lockedScope = scopeFingerprint(ctx);
      // 保留全部历史记录（成功项与失效项），只为没有成功记录的资产新建本批待执行记录：
      // 重试/重新批准不会重复建立已成功资产的记录
      const succeeded = new Set(action.isolationRecords.filter((r) => r.status === 'success').map((r) => r.assetId));
      lockedAssets = Array.from(new Set(ctx.affected));
      const pending = buildRecords(lockedAssets.filter((assetId) => !succeeded.has(assetId)));
      isolationRecords = [...action.isolationRecords, ...pending];
      justLocked = true;
    }
  }

  return {
    ok: true,
    justLocked,
    action: { ...action, approvals, status, lockedScope, lockedAssets, isolationRecords, version: action.version + 1 },
  };
}

/**
 * 范围变化（敏感级别或受影响资产）后的失效处理：
 * 仅影响“已按旧范围批准、尚未执行完成”的隔离动作；全部完成的不动。
 * 失效后退回待确认、解除范围锁定；逐项隔离记录中未完成的标记 invalidated，
 * 已成功的记录保留（资产仍处于隔离态，不能丢账）。
 */
export function invalidateStaleActions(
  actions: ResponseAction[],
  scope: IncidentScope,
): ResponseAction[] {
  const fingerprint = scopeFingerprint(scope);
  return actions.map((action) => {
    if (action.kind !== 'isolate') return action;
    if (action.status !== 'approved' && action.status !== 'partial') return action;
    if (!action.lockedScope || action.lockedScope === fingerprint) return action;
    return {
      ...action,
      // 旧范围的批准全部作废，退回待确认，重新走双人确认
      approvals: [],
      status: 'pending',
      lockedScope: undefined,
      lockedAssets: undefined,
      version: action.version + 1,
      isolationRecords: action.isolationRecords.map((record) =>
        record.status === 'success'
          ? record
          : { ...record, status: 'invalidated' as IsolationStatus, lastError: record.lastError ?? '范围已变更', lastAt: undefined },
      ),
    };
  });
}

/** 执行隔离前的统一守卫：权限/敏感/批准状态/隔离记录缺一不可 */
export function canRunIsolation(action: ResponseAction, role: Role, demoMode: boolean): RejectReason | null {
  if (demoMode) return 'demo-readonly';
  if (action.sensitive && !roleCanApprove(role)) return 'sensitive-role-not-allowed';
  if (!roleCanApprove(role)) return 'role-not-allowed';
  if (action.status !== 'approved' && action.status !== 'partial') return 'not-approved';
  if (!isReadyToRun(action)) return 'no-isolation-records';
  return null;
}

/**
 * 执行/重试隔离：按锁定范围内的资产逐项落地。
 * - 没有对应隔离记录（未经批准锁定）直接拒绝，不允许凭空执行。
 * - 只处理 pending/failed 记录：success 不再查询、不再执行；invalidated 不属本批。
 * - 单项失败只记该资产的账，其他资产照常执行，整批可停在 partial，下次重试补齐。
 */
export function runIsolation(ctx: RunContext): RunResult {
  const { action, role, demoMode, now, isolateAsset } = ctx;
  const guard = canRunIsolation(action, role, demoMode);
  if (guard) return { ok: false, reason: guard };

  const ran: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  const locked = new Set(action.lockedAssets);
  const isolationRecords = action.isolationRecords.map((record) => {
    // 成功的不再触碰；已失效的不属本批；锁定范围外（事后新增）的资产永不入批
    if (record.status === 'success') {
      return record;
    }
    if (record.status !== 'pending' && record.status !== 'failed') return record;
    if (!locked.has(record.assetId)) return record;

    ran.push(record.assetId);
    const result = isolateAsset(record.assetId);
    if (!result.ok) {
      failed.push(record.assetId);
      return { ...record, status: 'failed' as IsolationStatus, attempts: record.attempts + 1, lastError: result.error, lastAt: now };
    }
    succeeded.push(record.assetId);
    return { ...record, status: 'success' as IsolationStatus, attempts: record.attempts + 1, lastError: undefined, lastAt: now };
  });

  // 完成判定只统计本批有效记录；历史 invalidated 记录不参与
  const scopeRecords = isolationRecords.filter((r) => locked.has(r.assetId) && r.status !== 'invalidated');
  const allDone = scopeRecords.length > 0 && scopeRecords.every((r) => r.status === 'success');
  const anySuccess = scopeRecords.some((r) => r.status === 'success');
  const status: ActionStatus = allDone ? 'executed' : anySuccess ? 'partial' : 'approved';

  return {
    ok: true,
    ran,
    succeeded,
    failed,
    action: { ...action, isolationRecords, status, lockedScope: allDone ? action.lockedScope : action.lockedScope },
  };
}

/** 非隔离类动作（封禁/恢复/通知）的权限与状态校验，执行结果整体记账 */
export function canExecuteGeneric(action: ResponseAction, role: Role, demoMode: boolean): RejectReason | null {
  if (demoMode) return 'demo-readonly';
  if (action.sensitive && !roleCanApprove(role)) return 'sensitive-role-not-allowed';
  if (!roleCanApprove(role)) return 'role-not-allowed';
  if (action.approvals.length < REQUIRED_CONFIRMATIONS) return 'not-approved';
  if (action.status === 'executed') return 'already-completed';
  return null;
}

/** 非隔离类动作的确认：同样走权限、敏感、版本、重复角色校验；达到门槛即批准 */
export function confirmGeneric(ctx: ConfirmContext): ConfirmResult {
  const { action, role, expectedVersion, demoMode, now } = ctx;
  if (demoMode) return { ok: false, reason: 'demo-readonly' };
  if (action.sensitive && !roleCanApprove(role)) return { ok: false, reason: 'sensitive-role-not-allowed' };
  if (!roleCanApprove(role)) return { ok: false, reason: 'role-not-allowed' };
  if (expectedVersion !== action.version) return { ok: false, reason: 'version-stale' };
  if (action.approvals.some((entry) => entry.role === role)) return { ok: false, reason: 'duplicate-confirmation' };

  const approvals = [...action.approvals, { role, at: now, version: action.version }];
  const distinctRoles = new Set(approvals.map((entry) => entry.role));
  const status: ActionStatus = distinctRoles.size >= REQUIRED_CONFIRMATIONS && action.status !== 'executed'
    ? 'approved'
    : action.status;
  return { ok: true, justLocked: status === 'approved' && action.status !== 'approved', action: { ...action, approvals, status, version: action.version + 1 } };
}

/** 达到确认门槛、范围已锁定（存在待逐项落地的有效隔离记录） */
export function isReadyToRun(action: ResponseAction): boolean {
  return action.status === 'approved' || action.status === 'partial'
    ? action.isolationRecords.some((r) => r.status === 'pending' || r.status === 'failed')
    : false;
}

/** 重试时需要处理的资产：成功项不再查询、不再执行；失效项不属本批 */
export function pendingAssetIds(action: ResponseAction): string[] {
  return action.isolationRecords
    .filter((r) => (r.status === 'pending' || r.status === 'failed') && action.lockedAssets?.includes(r.assetId))
    .map((r) => r.assetId);
}

/**
 * 把执行器逐项返回的结果落到对应隔离记录上（逐资产记账），并重算动作状态。
 * 未出现在 outcomes 中的记录保持原状（单项失败/中断都保留未完成记录）。
 */
export function applyItemOutcomes(
  action: ResponseAction,
  outcomes: { assetId: string; status: IsolationStatus; error?: string }[],
  now: string,
): ResponseAction {
  const byAsset = new Map(outcomes.map((item) => [item.assetId, item]));
  const locked = new Set(action.lockedAssets ?? []);
  const isolationRecords = action.isolationRecords.map((record) => {
    const item = byAsset.get(record.assetId);
    if (!item) return record;
    return {
      ...record,
      status: item.status,
      attempts: record.attempts + 1,
      lastError: item.error,
      lastAt: now,
    };
  });
  const scopeRecords = isolationRecords.filter((r) => locked.has(r.assetId) && r.status !== 'invalidated');
  const allDone = scopeRecords.length > 0 && scopeRecords.every((r) => r.status === 'success');
  const anySuccess = scopeRecords.some((r) => r.status === 'success');
  const status: ActionStatus = allDone ? 'executed' : anySuccess ? 'partial' : 'approved';
  return { ...action, isolationRecords, status };
}

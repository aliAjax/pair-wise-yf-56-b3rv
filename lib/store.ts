import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Severity = 'medium' | 'high' | 'critical';
export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';
export type AssetIsolationStatus = 'pending' | 'succeeded' | 'failed';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ApprovalRecord { role: Role; at: string; }
export interface IsolationRecord { asset: string; status: AssetIsolationStatus; updatedAt: string; message?: string; }
export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: Role[];
  approvalRecords: ApprovalRecord[];
  status: ActionStatus;
  sensitive?: boolean;
  /** 乐观锁版本号：每次批准/作废自增，用于拒绝过期确认 */
  version: number;
  /** 批准时锁定的隔离范围快照；事后新增资产不属本批 */
  scope?: string[];
  /** 逐项隔离结果，失败后保留未完成记录 */
  isolation?: IsolationRecord[];
}
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
}

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  /** 提交审批；expectedVersion 为提交时所见版本，版本过期则不入库、不计批准人数 */
  approveAction: (id: string, expectedVersion: number) => { ok: boolean; reason?: string };
  executeAction: (id: string) => { ok: boolean; reason?: string };
  /** 重试隔离：只处理未成功项，已隔离成功的资产不再重复查询 */
  retryIsolation: (id: string) => { ok: boolean; reason?: string };
  reorderActions: (activeId: string, overId: string) => void;
  setSeverity: (severity: Severity) => void;
  addAffected: (asset: string) => void;
  removeAffected: (asset: string) => void;
  tick: () => void;
}

export const ROLE_NAMES: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
/** 敏感动作仅下发给有审批权限的角色（响应负责人、法务/公关） */
export const SENSITIVE_APPROVERS: Role[] = ['responder', 'legal'];

export function canSeeSensitive(role: Role): boolean { return SENSITIVE_APPROVERS.includes(role); }

/** 当前角色对该动作是否有审批权限：访客无权限；敏感动作仅响应/法务可批 */
export function canApprove(role: Role, action: ResponseAction): boolean {
  if (role === 'viewer') return false;
  if (action.sensitive) return SENSITIVE_APPROVERS.includes(role);
  return true;
}

export function requiredApprovals(action: ResponseAction): number { return action.kind === 'isolate' ? 2 : 1; }

const now = () => new Date().toISOString();

/** 模拟隔离代理：首次成功率约 60%，重试成功率约 85% */
function attemptIsolation(_asset: string, attempt: number): boolean {
  const rate = attempt <= 1 ? 0.6 : 0.85;
  return Math.random() < rate;
}

/**
 * 敏感级别或受影响资产变更后，按旧范围批准的待执行动作立即失效、退回待确认。
 * 已执行的动作不受影响；未执行动作的批准、锁定范围和逐项记录全部作废。
 */
function invalidateApprovals(incident: Incident, reason: string): Incident {
  const at = now();
  const reverted = incident.actions.filter((a) => a.status !== 'executed');
  const actions = incident.actions.map((a) => {
    if (a.status === 'executed') return a;
    return { ...a, approvals: [], approvalRecords: [], scope: undefined, isolation: undefined, status: 'pending' as const, version: a.version + 1 };
  });
  const timeline = [
    ...reverted.map((a, i) => ({ id: `e-inv-${a.id}-${Date.now()}-${i}`, at, actor: '系统', text: `${reason}：按旧范围批准的待执行动作「${a.title}」立即失效，退回待确认`, sensitive: a.sensitive })),
    ...incident.timeline
  ];
  return { ...incident, actions, timeline };
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['responder'], approvalRecords: [{ role: 'responder', at: now() }], status: 'pending', sensitive: true, version: 1 },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], approvalRecords: [], status: 'pending', version: 1 },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], approvalRecords: [{ role: 'legal', at: now() }], status: 'approved', sensitive: true, version: 1 }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

export const useIncidentStore = create<State>()(persist((set, get) => {
  /** 执行/重试的统一入口：逐项处理隔离结果，已成功项跳过，失败项保留待重试 */
  const processAction = (actionId: string): { ok: boolean; reason?: string } => {
    const state = get();
    const action = state.incident.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, reason: '动作不存在' };
    if (state.role === 'viewer') return { ok: false, reason: '访客无执行权限' };
    if (action.status !== 'approved') return { ok: false, reason: '动作未批准，不能执行' };

    if (action.kind === 'isolate') {
      if (action.approvals.length < 2) return { ok: false, reason: '隔离动作需两名不同角色确认' };
      const scope = action.scope ?? [];
      if (scope.length === 0) return { ok: false, reason: '隔离范围未锁定，拒绝执行' };
      const records = action.isolation ?? [];
      // 执行前校验：锁定范围内的每项资产都必须有对应的隔离记录，否则直接拒绝
      const missing = scope.filter((asset) => !records.some((r) => r.asset === asset));
      if (missing.length > 0) return { ok: false, reason: `缺少隔离记录，直接拒绝：${missing.join('、')}` };

      const at = now();
      const firstAttempt = records.every((r) => r.status === 'pending');
      const newRecords = records.map((r) => {
        if (r.status === 'succeeded') return r; // 已隔离成功，不再重复查询
        const ok = attemptIsolation(r.asset, r.status === 'failed' ? 2 : 1);
        if (ok) return { ...r, status: 'succeeded' as const, updatedAt: at, message: undefined };
        return { ...r, status: 'failed' as const, updatedAt: at, message: '隔离代理执行超时，保留未完成记录待重试' };
      });
      // 首次执行且多项全部成功时，强制暴露一项失败以演示逐项重试（模拟隔离代理部分失败）
      if (firstAttempt && scope.length > 1 && newRecords.every((r) => r.status === 'succeeded')) {
        const idx = newRecords.length - 1;
        newRecords[idx] = { ...newRecords[idx], status: 'failed', updatedAt: at, message: '隔离代理执行超时，保留未完成记录待重试' };
      }

      const succeeded = newRecords.filter((r) => r.status === 'succeeded').length;
      const failed = newRecords.filter((r) => r.status === 'failed').length;
      const allDone = failed === 0;
      const updated: ResponseAction = { ...action, isolation: newRecords, status: allDone ? 'executed' : 'approved' };
      const text = allDone
        ? `执行处置动作：${action.title}，${succeeded} 项资产隔离完成`
        : `执行处置动作：${action.title}，${succeeded} 项成功、${failed} 项失败；失败项保留记录，可单独重试，不影响已成功资产`;
      set({ incident: { ...state.incident, actions: state.incident.actions.map((a) => a.id === actionId ? updated : a), timeline: [{ id: `e-${Date.now()}`, at, actor: state.role, text, sensitive: action.sensitive }, ...state.incident.timeline] } });
      return { ok: allDone, reason: allDone ? undefined : `${failed} 项失败，可重试` };
    }

    // 非隔离动作（封禁/恢复/通知）：批准后单次执行
    const updated: ResponseAction = { ...action, status: 'executed' };
    set({ incident: { ...state.incident, actions: state.incident.actions.map((a) => a.id === actionId ? updated : a), timeline: [{ id: `e-${Date.now()}`, at: now(), actor: state.role, text: `执行处置动作：${action.title}`, sensitive: action.sensitive }, ...state.incident.timeline] } });
    return { ok: true };
  };

  return {
    incident: initial, role: 'analyst', demoMode: false,
    setRole: (role) => set({ role }),
    toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
    addSubIncident: (payload) => { if (get().demoMode) return; set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [{ id: `e-${Date.now()}`, at: now(), actor: '响应负责人', text: `创建子事件：${payload.title}` }, ...state.incident.timeline] } })); },

    approveAction: (id, expectedVersion) => {
      if (get().demoMode) return { ok: false, reason: '演示模式已冻结操作' };
      const state = get();
      const action = state.incident.actions.find((item) => item.id === id);
      if (!action) return { ok: false, reason: '动作不存在' };
      if (action.status === 'executed') return { ok: false, reason: '动作已执行，无需批准' };
      if (!canApprove(state.role, action)) return { ok: false, reason: '当前角色无审批权限' };
      if (action.approvals.includes(state.role)) return { ok: false, reason: '已批准，无需重复确认' };
      // 乐观锁：后者提交版本已过期，本次确认不入库、不计批准人数
      if (action.version !== expectedVersion) return { ok: false, reason: '提交的版本已过期，本次确认不入库' };

      const at = now();
      const newApprovals = [...action.approvals, state.role];
      const willApprove = newApprovals.length >= requiredApprovals(action);
      const updated: ResponseAction = {
        ...action,
        approvals: newApprovals,
        approvalRecords: [...action.approvalRecords, { role: state.role, at }],
        version: action.version + 1,
        status: willApprove ? 'approved' : 'pending'
      };
      // 批准时锁定隔离范围快照，并为范围内每项资产建立隔离记录
      if (willApprove && action.kind === 'isolate') {
        updated.scope = [...state.incident.affected];
        updated.isolation = state.incident.affected.map((asset) => ({ asset, status: 'pending', updatedAt: at }));
      }
      set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? updated : item), timeline: [{ id: `e-${Date.now()}`, at, actor: state.role, text: `审批处置动作：${action.title}（${newApprovals.length}/${requiredApprovals(action)}）`, sensitive: action.sensitive }, ...state.incident.timeline] } });
      return { ok: true };
    },

    executeAction: (id) => { if (get().demoMode) return { ok: false, reason: '演示模式已冻结操作' }; return processAction(id); },
    retryIsolation: (id) => { if (get().demoMode) return { ok: false, reason: '演示模式已冻结操作' }; return processAction(id); },

    reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode) return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, actions } }); },

    setSeverity: (severity) => { if (get().demoMode) return; set((state) => ({ incident: invalidateApprovals({ ...state.incident, severity }, '敏感级别变更') })); },
    addAffected: (asset) => {
      const value = asset.trim();
      if (!value || get().demoMode) return;
      const state = get();
      if (state.incident.affected.includes(value)) return;
      set((s) => ({ incident: invalidateApprovals({ ...s.incident, affected: [...s.incident.affected, value] }, '受影响资产变更') }));
    },
    removeAffected: (asset) => { if (get().demoMode) return; set((s) => ({ incident: invalidateApprovals({ ...s.incident, affected: s.incident.affected.filter((a) => a !== asset) }, '受影响资产变更') })); },

    tick: () => set((state) => ({ incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}`, at: now(), actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新` }, ...state.incident.timeline].slice(0, 30) } }))
  };
}, { name: 'yf56-incident-store-v2' }));

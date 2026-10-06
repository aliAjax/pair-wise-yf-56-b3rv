import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyItemOutcomes,
  canExecuteGeneric,
  canRunIsolation,
  confirmGeneric,
  confirmIsolation,
  invalidateStaleActions,
  isReadyToRun,
  pendingAssetIds,
  type RejectReason,
  type ResponseAction,
  type Role,
  type Severity,
} from './isolation';
import { isolateAssetsByItem, type AssetRunOutcome } from './executor';

export type { ResponseAction, Role, Severity, RejectReason } from './isolation';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
}

export interface StoreResult { ok: boolean; reason?: RejectReason; message?: string }

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  /** 正在逐项执行中的动作 id，用于界面禁用与进度展示 */
  running: string | null;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => StoreResult;
  /** 确认动作（携带渲染时看到的版本号，过期确认会被拒绝） */
  confirmAction: (id: string, expectedVersion: number) => StoreResult;
  /** 执行：隔离类逐资产落地（可重入重试），其余动作整体执行 */
  executeAction: (id: string) => Promise<StoreResult>;
  reorderActions: (activeId: string, overId: string) => void;
  addAffected: (assetId: string) => StoreResult;
  setSeverity: (severity: Severity) => StoreResult;
  tick: () => void;
  pushTimeline: (event: Omit<TimelineEvent, 'id' | 'at'>) => void;
}

let eventSeq = 0;
function eventId(): string {
  eventSeq += 1;
  return `e-${Date.now().toString(36)}-${eventSeq}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

// 演示执行器：首次隔离 audit-log 会超时，重试成功，用于演示失败保留与重试补齐
// 演示执行器：audit-log 全局第一次隔离调用超时、之后成功（模拟偶发故障后重试恢复）；
// 也可通过 queueDemoFailures 指定资产的下一次隔离调用失败
let auditFirstCallDone = false;
const forcedFailureAssets: string[] = [];
/** 安排指定资产的下一次隔离调用失败（每次执行消费一次） */
export function queueDemoFailures(assetId = 'audit-log'): void {
  forcedFailureAssets.push(assetId);
}
/** 清除被安排的失败（测试用；不清空已隔绝状态，模拟真实资产状态留存） */
export function resetDemoEndpoint(): void {
  forcedFailureAssets.length = 0;
}
const isolated = new Set<string>();
const endpoint = {
  isolate: async (assetId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));
    const forcedIndex = forcedFailureAssets.indexOf(assetId);
    if (forcedIndex >= 0) {
      forcedFailureAssets.splice(forcedIndex, 1);
      throw new Error(`资产 ${assetId} 隔离接口超时`);
    }
    if (assetId === 'audit-log' && !auditFirstCallDone) {
      auditFirstCallDone = true;
      throw new Error('资产 audit-log 隔离接口超时');
    }
    isolated.add(assetId);
  },
  status: async (assetId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return (isolated.has(assetId) ? 'isolated' : 'reachable') as 'isolated' | 'reachable';
  },
};

const initial: Incident = {
  id: 'INC-2026-0929',
  title: '对外网关异常凭证使用',
  severity: 'critical',
  status: 'investigating',
  affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' },
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: [], status: 'pending', version: 1, sensitive: true, isolationRecords: [] },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending', version: 1, isolationRecords: [] },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: [], status: 'pending', version: 1, sensitive: true, isolationRecords: [] },
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' },
  ],
};

function reject(reason: RejectReason): StoreResult {
  return { ok: false, reason };
}

/** 统计本次范围变化中由“已批准/部分完成”退回“待确认”的动作数量 */
function countInvalidated(before: ResponseAction[], after: ResponseAction[]): number {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  return after.filter((item) => item.status === 'pending' && beforeById.get(item.id)?.status !== 'pending').length;
}

export const reasonText: Record<RejectReason, string> = {
  'not-found': '动作不存在',
  'demo-readonly': '只读演示模式已开启，操作被冻结',
  'role-not-allowed': '当前角色没有审批/执行权限',
  'sensitive-role-not-allowed': '敏感处置动作不对当前角色下发',
  'duplicate-confirmation': '同一角色不能重复确认',
  'version-stale': '版本已过期：动作范围或确认状态刚被更新，本次确认不入库也不计批准人数',
  'not-approved': '尚未达到双人确认，不能执行',
  'already-completed': '动作已全部执行完成',
  'no-isolation-records': '执行前没有对应隔离记录，已直接拒绝',
};

export const useIncidentStore = create<State>()(
  persist(
    (set, get) => {
      const patchAction = (id: string, updater: (action: ResponseAction) => ResponseAction) => {
        set((state) => ({
          incident: {
            ...state.incident,
            actions: state.incident.actions.map((item) => (item.id === id ? updater(item) : item)),
          },
        }));
      };

      return {
        incident: initial,
        role: 'analyst',
        demoMode: false,
        running: null,

        setRole: (role) => set({ role }),
        toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),

        pushTimeline: (event) => {
          const entry: TimelineEvent = { id: eventId(), at: nowIso(), ...event };
          set((state) => ({
            incident: { ...state.incident, timeline: [entry, ...state.incident.timeline].slice(0, 60) },
          }));
        },

        addSubIncident: (payload) => {
          if (get().demoMode) return reject('demo-readonly');
          set((state) => ({
            incident: {
              ...state.incident,
              subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }],
              timeline: [
                { id: eventId(), at: nowIso(), actor: state.role, text: `创建子事件：${payload.title}` },
                ...state.incident.timeline,
              ].slice(0, 60),
            },
          }));
          return { ok: true };
        },

        confirmAction: (id, expectedVersion) => {
          const state = get();
          const action = state.incident.actions.find((item) => item.id === id);
          if (!action) return reject('not-found');
          const result = action.kind === 'isolate'
            ? confirmIsolation({
                severity: state.incident.severity,
                affected: state.incident.affected,
                action,
                role: state.role,
                expectedVersion,
                demoMode: state.demoMode,
                now: nowIso(),
              })
            : confirmGeneric({
                severity: state.incident.severity,
                affected: state.incident.affected,
                action,
                role: state.role,
                expectedVersion,
                demoMode: state.demoMode,
                now: nowIso(),
              });
          if (result.ok === false) return reject(result.reason as RejectReason);

          const locked = result.justLocked;
          set((s) => ({
            incident: {
              ...s.incident,
              actions: s.incident.actions.map((item) => (item.id === id ? result.action : item)),
              timeline: [
                {
                  id: eventId(),
                  at: nowIso(),
                  actor: s.role,
                  text: locked
                    ? `双人确认完成，已按当前范围锁定 ${result.action.lockedAssets?.length ?? 0} 项资产：${action.title}`
                    : `确认处置动作（第 ${result.action.approvals.length} 人）：${action.title}`,
                  sensitive: action.sensitive,
                },
                ...s.incident.timeline,
              ].slice(0, 60),
            },
          }));
          return { ok: true };
        },

        executeAction: async (id) => {
          const state = get();
          const action = state.incident.actions.find((item) => item.id === id);
          if (!action) return reject('not-found');

          if (action.kind === 'isolate') {
            const guard = canRunIsolation(action, state.role, state.demoMode);
            if (guard) return reject(guard);
            const assets = pendingAssetIds(action);
            if (assets.length === 0) return reject('no-isolation-records');

            set({ running: id });
            get().pushTimeline({
              actor: state.role,
              text: `开始逐项隔离 ${assets.length} 项未完成资产：${assets.join('、')}（已成功项不再查询）`,
              sensitive: action.sensitive,
            });

            let outcomes: AssetRunOutcome[] = [];
            try {
              outcomes = await isolateAssetsByItem({
                endpoint,
                assetIds: assets,
                onItem: (outcome) => {
                  // 每个资产结果单独记账：单项完成即落一条，失败也保留未完成记录
                  const current = get().incident.actions.find((item) => item.id === id);
                  if (!current) return;
                  patchAction(id, (a) => applyItemOutcomes(a, [outcome], nowIso()));
                  get().pushTimeline({
                    actor: '隔离执行器',
                    text: outcome.status === 'success'
                      ? `资产 ${outcome.assetId} 隔离成功`
                      : `资产 ${outcome.assetId} 隔离失败，保留未完成记录：${outcome.error ?? '未知原因'}`,
                  });
                },
              });
            } finally {
              set({ running: null });
            }

            const finalAction = get().incident.actions.find((item) => item.id === id);
            const failedCount = outcomes.filter((o) => o.status !== 'success').length;
            if (finalAction?.status === 'executed') {
              get().pushTimeline({
                actor: '隔离执行器',
                text: `隔离动作「${action.title}」全部资产落地完成`,
                sensitive: action.sensitive,
              });
              return { ok: true, message: '全部资产隔离成功' };
            }
            return {
              ok: false,
              reason: 'already-completed',
              message: `部分完成：${outcomes.length - failedCount} 项成功，${failedCount} 项失败，可重试只处理失败项`,
            };
          }

          const guard = canExecuteGeneric(action, state.role, state.demoMode);
          if (guard) return reject(guard);
          set((s) => ({
            incident: {
              ...s.incident,
              actions: s.incident.actions.map((item) => (item.id === id ? { ...item, status: 'executed' as const } : item)),
              timeline: [
                { id: eventId(), at: nowIso(), actor: s.role, text: `执行处置动作：${action.title}`, sensitive: action.sensitive },
                ...s.incident.timeline,
              ].slice(0, 60),
            },
          }));
          return { ok: true };
        },

        reorderActions: (activeId, overId) => {
          const s = get();
          if (s.demoMode) return;
          const actions = [...s.incident.actions];
          const from = actions.findIndex((item) => item.id === activeId);
          const to = actions.findIndex((item) => item.id === overId);
          if (from < 0 || to < 0) return;
          const [moved] = actions.splice(from, 1);
          actions.splice(to, 0, moved);
          set({ incident: { ...s.incident, actions } });
        },

        addAffected: (assetId) => {
          const s = get();
          if (s.demoMode) return reject('demo-readonly');
          const trimmed = assetId.trim();
          if (!trimmed) return reject('not-found');
          if (s.incident.affected.includes(trimmed)) return { ok: true, message: '资产已在范围内' };
          const affected = [...s.incident.affected, trimmed];
          const actions = invalidateStaleActions(s.incident.actions, { severity: s.incident.severity, affected });
          const invalidatedCount = countInvalidated(s.incident.actions, actions);
          set({
            incident: {
              ...s.incident,
              affected,
              actions,
              timeline: [
                {
                  id: eventId(),
                  at: nowIso(),
                  actor: s.role,
                  text: invalidatedCount > 0
                    ? `受影响资产新增 ${trimmed}：${invalidatedCount} 个按旧范围批准的待执行隔离动作已失效退回待确认，锁定范围不含该资产`
                    : `受影响资产新增 ${trimmed}`,
                },
                ...s.incident.timeline,
              ].slice(0, 60),
            },
          });
          return { ok: true };
        },

        setSeverity: (severity) => {
          const s = get();
          if (s.demoMode) return reject('demo-readonly');
          if (severity === s.incident.severity) return { ok: true };
          const actions = invalidateStaleActions(s.incident.actions, { severity, affected: s.incident.affected });
          const invalidatedCount = countInvalidated(s.incident.actions, actions);
          set({
            incident: {
              ...s.incident,
              severity,
              actions,
              timeline: [
                {
                  id: eventId(),
                  at: nowIso(),
                  actor: s.role,
                  text: invalidatedCount > 0
                    ? `敏感级别调整为 ${severity}：${invalidatedCount} 个按旧范围批准的待执行隔离动作已失效退回待确认`
                    : `敏感级别调整为 ${severity}`,
                },
                ...s.incident.timeline,
              ].slice(0, 60),
            },
          });
          return { ok: true };
        },

        tick: () =>
          set((state) => ({
            incident: {
              ...state.incident,
              timeline: [
                {
                  id: eventId(),
                  at: nowIso(),
                  actor: '监测代理',
                  text: `实时检查：${state.incident.affected.length} 项资产状态已更新`,
                },
                ...state.incident.timeline,
              ].slice(0, 30),
            },
          })),
      };
    },
    {
      name: 'yf56-incident-store-v2',
      version: 2,
      // 服务端预渲染没有 localStorage：用 noop 存储兜底，避免创建期访问浏览器 API
      storage: createJSONStorage(() =>
        typeof window === 'undefined'
          ? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
          : window.localStorage,
      ),
      // 旧持久化结构缺少版本号与逐资产记录，直接丢弃重新初始化
      migrate: () => initial,
    },
  ),
);

export { isReadyToRun, pendingAssetIds };

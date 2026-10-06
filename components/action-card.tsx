'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, CheckCircle2, GripVertical, Loader2, Lock, Play, RotateCw, UserCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { reasonText, useIncidentStore, type ResponseAction } from '@/lib/store';
import { roleCanApprove, roleCanSeeSensitive, type IsolationStatus, type Role } from '@/lib/isolation';

const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const kindNames = { isolate: '隔离', block: '封禁', restore: '恢复', notify: '通知' } as const;
const statusNames = { pending: '待确认', approved: '已批准待执行', partial: '部分完成', executed: '已执行' } as const;

const recordView: Record<IsolationStatus, { label: string; cls: string }> = {
  pending: { label: '待隔离', cls: 'rec-pending' },
  success: { label: '已隔离', cls: 'rec-success' },
  failed: { label: '失败待重试', cls: 'rec-failed' },
  invalidated: { label: '旧范围已失效', cls: 'rec-invalid' },
};

export function ActionCard({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  // 界面展示的版本即本卡片渲染时持有的版本；确认时回传，过期会被拒绝
  const [heldVersion, setHeldVersion] = useState(action.version);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    // 动作被他人/他处更新后同步版本；若用户正基于旧值操作，下一次确认将收到 version-stale
    setHeldVersion(action.version);
  }, [action.version]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const canApprove = roleCanApprove(store.role);
  const canSee = roleCanSeeSensitive(action, store.role);
  const alreadyConfirmed = action.approvals.some((entry) => entry.role === store.role);
  const isIsolate = action.kind === 'isolate';
  const running = store.running === action.id;
  const done = isIsolate ? action.isolationRecords.filter((r) => r.status === 'success').length : 0;
  const totalLocked = action.lockedAssets?.length ?? 0;
  const activeRecords = action.isolationRecords.filter((r) => r.status !== 'invalidated');
  const staleHeld = heldVersion !== action.version;

  function confirm() {
    const result = store.confirmAction(action.id, heldVersion);
    if (!result.ok) {
      setFeedback({ ok: false, text: reasonText[result.reason ?? 'not-found'] });
    } else {
      setFeedback({ ok: true, text: '确认已记账' });
    }
  }

  async function execute() {
    setFeedback(null);
    const result = await store.executeAction(action.id);
    setFeedback({
      ok: result.ok,
      text: result.message ?? (result.ok ? '执行完成' : reasonText[result.reason ?? 'not-found']),
    });
  }

  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-card">
      <div className="action-main">
        <button type="button" className="grip" {...sortable.attributes} {...sortable.listeners} aria-label="拖拽排序"><GripVertical size={15} /></button>
        <div className="action-body">
          <div className="action-head">
            <strong>{canSee ? action.title : '敏感处置动作（当前角色无权查看内容）'}</strong>
            <span className="badges">
              <Badge>{kindNames[action.kind]}</Badge>
              <Badge className={action.status === 'executed' ? 'ok' : action.status === 'partial' ? 'warn' : ''}>{statusNames[action.status]}</Badge>
              {action.sensitive && canSee && <Badge className="danger">敏感</Badge>}
              {action.sensitive && !canSee && <Badge className="danger">内容已遮蔽</Badge>}
            </span>
          </div>

          {canSee && (
            <div className="muted">
              版本 v{action.version}
              {staleHeld ? ' · 你持有的确认版本已过期，请以最新状态重新确认' : ' · 确认时携带此版本号'}
              {' · '}确认人：{action.approvals.length ? action.approvals.map((entry) => `${roleNames[entry.role]}(v${entry.version})`).join('、') : '无'}
              <span className="conf">（隔离动作需两名不同角色）</span>
            </div>
          )}

          {action.lockedAssets && (
            <div className="locked-scope">
              <Lock size={13} /> 批准时已锁定范围（{totalLocked} 项）：{action.lockedAssets.join('、')}
              <span className="muted">，事后新增资产不进入本批</span>
            </div>
          )}

          {isIsolate && activeRecords.length > 0 && (
            <div className="iso-records">
              <div className="muted">逐资产隔离结果{totalLocked > 0 && <>（{done}/{totalLocked} 已隔绝）</>}：</div>
              <ul>
                {action.isolationRecords.map((record) => {
                  const view = recordView[record.status];
                  return (
                    <li key={record.id} className={view.cls}>
                      {record.status === 'success' ? <CheckCircle2 size={13} /> : record.status === 'failed' ? <AlertTriangle size={13} /> : record.status === 'invalidated' ? <XCircle size={13} /> : <Loader2 size={13} />}
                      <code>{record.assetId}</code>
                      <span>{view.label}</span>
                      <em>第 {record.attempts} 次尝试{record.lastError ? `：${record.lastError}` : ''}</em>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        <div className="row-actions">
          <Button size="sm" variant="outline" disabled={store.demoMode || !canApprove || alreadyConfirmed || action.status === 'executed' || running} onClick={confirm}>
            <UserCheck size={14} />{alreadyConfirmed ? '已确认' : '确认'}
          </Button>
          <Button size="sm" disabled={store.demoMode || !canApprove || running} onClick={execute}>
            {running
              ? <><Loader2 size={14} className="spin" />逐项执行中</>
              : isIsolate && action.status === 'partial'
                ? <><RotateCw size={14} />重试未完成项</>
                : <><Play size={14} />{isIsolate ? (action.status === 'approved' ? '执行隔离' : '执行') : '执行动作'}</>}
          </Button>
        </div>
      </div>
      {feedback && <div className={`action-feedback ${feedback.ok ? 'ok' : 'err'}`}>{feedback.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{feedback.text}</div>}
    </div>
  );
}

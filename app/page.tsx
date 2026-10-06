'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Lock, Radio, ShieldAlert, UserCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ROLE_NAMES,
  canApprove,
  canSeeSensitive,
  requiredApprovals,
  useIncidentStore,
  type ResponseAction,
  type Severity
} from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const severityNames: Record<Severity, string> = { medium: '中', high: '高', critical: '严重' };

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const [feedback, setFeedback] = useState<string | null>(null);
  const canSee = !action.sensitive || canSeeSensitive(store.role);
  const required = requiredApprovals(action);
  const failedCount = action.isolation?.filter((r) => r.status === 'failed').length ?? 0;
  const isPartial = action.status === 'approved' && failedCount > 0;

  function handleApprove() {
    const res = store.approveAction(action.id, action.version);
    setFeedback(res.ok ? null : (res.reason ?? '审批未生效'));
  }
  function handleExecute() {
    const res = store.executeAction(action.id);
    setFeedback(res.ok ? null : (res.reason ?? '执行被拒绝'));
  }

  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-card">
      <div className="action-head">
        <div>
          <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
          <div className="muted">
            {action.kind} · 状态 {action.status}
            {canSee && <> · 批准 {action.approvals.length}/{required}</>}
            {canSee && <> · 版本 v{action.version}</>}
          </div>
        </div>
        <div className="badges">
          {action.sensitive && <Badge className="sensitive">敏感</Badge>}
          {canSee && action.scope && <Badge className="locked"><Lock size={11} />范围已锁定</Badge>}
          {canSee && isPartial && <Badge className="failed">{failedCount} 项失败待重试</Badge>}
        </div>
      </div>

      {!canSee && <div className="muted sensitive-note">该动作内容敏感，仅下发给有审批权限的角色。</div>}

      {canSee && action.approvalRecords.length > 0 && (
        <div className="approval-records">
          <span className="muted">审批记录：</span>
          {action.approvalRecords.map((rec, i) => (
            <span key={i} className="approval-chip">{ROLE_NAMES[rec.role]} · {formatDistanceToNow(new Date(rec.at), { addSuffix: true, locale: zhCN })}</span>
          ))}
        </div>
      )}

      {canSee && action.kind === 'isolate' && action.scope && (
        <div className="scope-block">
          <div className="muted">隔离范围（批准时锁定，共 {action.scope.length} 项；事后新增资产不属本批）：</div>
          <div className="asset-chips">
            {action.scope.map((asset) => {
              const rec = action.isolation?.find((r) => r.asset === asset);
              const st = rec?.status ?? 'pending';
              return <span key={asset} className={`asset-chip ${st}`}>{asset} · {st === 'succeeded' ? '已隔离' : st === 'failed' ? '失败' : '待隔离'}</span>;
            })}
          </div>
        </div>
      )}

      {feedback && <div className="feedback">{feedback}</div>}

      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={store.demoMode || !canApprove(store.role, action) || action.status !== 'pending' || action.approvals.includes(store.role)} onClick={handleApprove}>
          <UserCheck size={14} />审批
        </Button>
        {action.status === 'approved' && (
          <Button size="sm" disabled={store.demoMode || store.role === 'viewer'} onClick={handleExecute}>
            {isPartial ? `重试失败项（${failedCount}）` : '执行'}
          </Button>
        )}
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

function AffectedEditor() {
  const store = useIncidentStore();
  const [draft, setDraft] = useState('');
  return (
    <div className="affected-editor">
      <div className="muted">受影响资产（变更将退回已批准动作）：</div>
      <div className="asset-chips">
        {store.incident.affected.map((asset) => (
          <span key={asset} className="asset-chip editable">{asset}{!store.demoMode && <button type="button" onClick={() => store.removeAffected(asset)}>×</button>}</span>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { store.addAffected(draft); setDraft(''); } }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="新增受影响资产，如 db-shard-03" disabled={store.demoMode} />
        <Button type="submit" size="sm" disabled={store.demoMode || !draft.trim()}>添加资产</Button>
      </form>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(ROLE_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent>
          <div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div>
          <div className="severity-row">
            <span className="muted">敏感级别</span>
            <select value={incident.severity} onChange={(e) => store.setSeverity(e.target.value as Severity)} disabled={store.demoMode}>
              {Object.entries(severityNames).map(([key, label]) => <option key={key} value={key}>{label}（{key}）</option>)}
            </select>
          </div>
          <AffectedEditor />
          <h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
        </CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认，批准时锁定范围并逐项记录结果；敏感动作仅下发给有审批权限的角色。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive(store.role) ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}

'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Plus, Radio, ShieldAlert, UserCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { ActionCard } from '@/components/action-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { reasonText, useIncidentStore } from '@/lib/store';
import { roleCanApprove, roleCanSeeSensitive, type Role, type Severity } from '@/lib/isolation';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const assetSchema = z.object({ assetId: z.string().min(2, '请填写资产标识') });
const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const severities: Severity[] = ['medium', 'high', 'critical'];

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const assetForm = useForm<z.infer<typeof assetSchema>>({ resolver: zodResolver(assetSchema), defaultValues: { assetId: '' } });
  const [assetError, setAssetError] = useState<string | null>(null);
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode, store]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = roleCanApprove(store.role);
  const isolatedAssets = new Set(
    incident.actions
      .filter((a) => a.kind === 'isolate')
      .flatMap((a) => a.isolationRecords.filter((r) => r.status === 'success').map((r) => r.assetId)),
  );

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：确认、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics">
      <Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card>
      <Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card>
      <Card><CardContent><span>隔离落地</span><strong>{isolatedAssets.size}/{incident.affected.length}</strong><small>已隔绝资产/受影响资产</small></CardContent></Card>
    </section>
    <section className="grid">
      <div className="stack">
        <Card>
          <CardHeader><div><h2>事件摘要</h2><p className="muted">敏感级别与受影响资产变化时，按旧范围批准、尚未执行完的隔离动作立即失效退回待确认。</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader>
          <CardContent>
            <div className="scope-controls">
              <label>敏感级别
                <select value={incident.severity} disabled={store.demoMode} onChange={(event) => {
                  const result = store.setSeverity(event.target.value as Severity);
                  if (!result.ok && result.reason) setAssetError(reasonText[result.reason]);
                }}>
                  {severities.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
              <form onSubmit={assetForm.handleSubmit((values) => {
                const result = store.addAffected(values.assetId);
                if (result.ok) { assetForm.reset(); setAssetError(null); }
                else if (result.reason) setAssetError(reasonText[result.reason]);
              })} className="asset-form">
                <label>新增受影响资产（批准后新增不进入已锁定批次）
                  <Input {...assetForm.register('assetId')} placeholder="例如：edge-node-7" />
                </label>
                <small className="error">{assetForm.formState.errors.assetId?.message ?? assetError}</small>
                <Button type="submit" size="sm" variant="outline" disabled={store.demoMode}><Plus size={14} />加入范围</Button>
              </form>
            </div>
            <div className="affected-list">
              {incident.affected.map((asset) => <Badge key={asset} className={isolatedAssets.has(asset) ? 'ok' : ''}>{asset}{isolatedAssets.has(asset) ? ' · 已隔绝' : ''}</Badge>)}
            </div>
            <h3>子事件</h3>
            {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认并携带版本号；确认完成即按当前级别与资产锁定范围。敏感动作内容不下发给无审批权限角色，执行前无隔离记录直接拒绝。</p></div><Users size={20} /></CardHeader>
          <CardContent>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div className="action-list">{incident.actions.map((action) => <ActionCard key={action.id} action={action} />)}</div>
              </SortableContext>
            </DndContext>
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card><CardHeader><div><h2>规则要点</h2><p className="muted">本作战室的隔离纪律</p></div><UserCheck size={20} /></CardHeader><CardContent><ul className="rules">
          <li>逐资产落地：单项失败不回滚整批，每项结果单独记账。</li>
          <li>重试只处理未成功资产，已隔绝成功的不再查询、不再执行。</li>
          <li>两人前后几秒确认同一动作：持过期版本者不入库、不计批准人数。</li>
          <li>敏感级别或受影响资产变化，旧范围批准的待执行动作立即失效。</li>
          <li>范围在批准时锁定，事后新增资产不进入这一批。</li>
          <li>敏感内容仅对有审批权限角色可见，无隔离记录不得执行。</li>
        </ul></CardContent></Card>
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">资产、动作、审批与逐项隔离结果合并记录</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}

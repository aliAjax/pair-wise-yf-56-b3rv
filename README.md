# pair-wise-yf-56 网络安全事件响应作战室

## 源提示词摘要
值班人员接收告警，分析人员补充资产和影响范围，响应负责人批准隔离、封禁或恢复动作，法务和公关维护对外口径。系统展示实时事件时间线、子事件、审批、证据和责任人；高优先级动作双人确认，敏感内容按角色显示，并支持只读演示模式。

## 技术栈
Next.js 15 + TypeScript + App Router + shadcn/ui 本地组件 + Zustand + TanStack Query + React Hook Form + Zod + next-intl + date-fns + dnd-kit。

## 已实现闭环
- 主事件、子事件、处置动作和实时时间线。
- 子事件创建、动作审批、双人确认和执行状态流转。
- 角色权限控制、敏感内容遮蔽、只读演示模式。
- dnd-kit 调整处置优先级、TanStack Query 实时连接检查和 Zustand 持久化。

## 启动
```bash
npm install
npm run dev
```
开发端口：62021

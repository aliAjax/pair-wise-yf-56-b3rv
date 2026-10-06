import type { IsolationRecord } from './isolation';

export interface AssetEndpoint {
  /** 单项隔离调用；抛错或返回 ok:false 均只影响该资产 */
  isolate: (assetId: string) => Promise<void>;
  /** 重试时只查询尚未成功的资产；成功资产不再查询 */
  status: (assetId: string) => Promise<'isolated' | 'reachable' | 'unknown'>;
}

export interface AssetRunOutcome {
  assetId: string;
  status: IsolationRecord['status'];
  error?: string;
}

export interface ExecutorOptions {
  endpoint: AssetEndpoint;
  /** 只传入“未成功”的资产；成功项已在上游排除 */
  assetIds: string[];
  signal?: AbortSignal;
  onItem?: (outcome: AssetRunOutcome) => void;
}

/** 并发上限，避免一次性冲击所有资产 */
const CONCURRENCY = 4;

/**
 * 逐资产落地隔离：每个资产独立尝试，单项失败不抛出、不回滚、不影响其余项。
 * 返回每项的结果供上层逐条记账；调用方负责跳过已成功资产（此处不再查询它们）。
 */
export async function isolateAssetsByItem(options: ExecutorOptions): Promise<AssetRunOutcome[]> {
  const { endpoint, assetIds, signal, onItem } = options;
  const outcomes: AssetRunOutcome[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < assetIds.length) {
      if (signal?.aborted) return;
      const assetId = assetIds[cursor++];
      let outcome: AssetRunOutcome;
      try {
        await endpoint.isolate(assetId);
        // 只查询这一个未成功资产的最新状态；成功资产不会出现在 assetIds 中
        const state = await endpoint.status(assetId);
        outcome = state === 'isolated'
          ? { assetId, status: 'success' }
          : { assetId, status: 'failed', error: `隔离后状态为 ${state}` };
      } catch (error) {
        outcome = { assetId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push(outcome);
      onItem?.(outcome);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(assetIds.length, 1)) }, worker));
  return outcomes;
}

/** 演示用执行器：按资产名包含的标记模拟成功/失败，便于在界面演示逐项记账 */
export function makeDemoEndpoint(failPatterns: string[] = ['audit-log']): AssetEndpoint {
  const isolated = new Set<string>();
  return {
    isolate: async (assetId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 260));
      if (failPatterns.some((pattern) => assetId.includes(pattern))) {
        throw new Error(`资产 ${assetId} 隔离接口超时`);
      }
      isolated.add(assetId);
    },
    status: async (assetId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return isolated.has(assetId) ? 'isolated' : 'reachable';
    },
  };
}

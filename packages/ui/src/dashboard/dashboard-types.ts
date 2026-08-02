export interface SubscriptionAutoUpdateState {
  externalFailureCount: number;
  failureSourceState?: string | null;
  lastFailedAt: string | null;
  lastAttemptedAt?: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  disabledPreviousInterval: number | null;
}

export interface Subscription {
  id: string;
  name: string;
  token: string;
  subscriptionUrl: string;
  isPrimary: boolean;
  autoUpdateInterval: number | null;
  autoUpdateState: SubscriptionAutoUpdateState;
  smartNodeMatchingEnabled: boolean;
  lastUpdatedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
}

export interface RefreshSubscriptionResponse {
  error?: string;
  refreshableSourceCount?: number;
  refreshedSourceCount?: number;
  refreshedUrlSourceCount?: number;
  refreshedStaticSourceCount?: number;
  failedSourceCount?: number;
  nodeCount?: number;
  attemptedUrlFetch?: boolean;
  usedUrlFetch?: boolean;
  // 本次刷新测活的统计（开启自动测活时）：tested=带测活结果的节点数，ok=通过节点数
  healthStats?: {
    tested: number;
    ok: number;
    fail: number;
    unsupported: number;
  };
}

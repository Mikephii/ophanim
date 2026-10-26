import type {
  FunctionFilters,
  PaginationParams,
  SecurityFilters,
} from '../api/types'

export const queryKeys = {
  dashboard: {
    stats: () => ['dashboard', 'stats'] as const,
  },
  repos: {
    list: () => ['repos', 'list'] as const,
    detail: (id: string) => ['repos', 'detail', id] as const,
  },
  stats: {
    overview: (repoId: string) =>
      ['repos', repoId, 'stats', 'overview'] as const,
    securityBreakdown: (repoId: string) =>
      ['repos', repoId, 'stats', 'security-breakdown'] as const,
  },
  functions: {
    list: (repoId: string, filters?: FunctionFilters & PaginationParams) =>
      ['repos', repoId, 'functions', 'list', filters] as const,
    detail: (repoId: string, hash: string) =>
      ['repos', repoId, 'functions', 'detail', hash] as const,
  },
  security: {
    dashboard: (repoId: string) =>
      ['repos', repoId, 'security', 'dashboard'] as const,
    issues: (repoId: string, filters?: SecurityFilters & PaginationParams) =>
      ['repos', repoId, 'security', 'issues', filters] as const,
    dismissed: (repoId: string) =>
      ['repos', repoId, 'security', 'dismissed'] as const,
  },
  practices: {
    list: (repoId: string) =>
      ['repos', repoId, 'practices', 'list'] as const,
  },
  architecture: {
    hierarchy: (repoId: string, algorithm?: string) =>
      ['repos', repoId, 'architecture', 'hierarchy', algorithm ?? 'leiden'] as const,
    communityDetail: (repoId: string, communityId: string, algorithm?: string) =>
      ['repos', repoId, 'architecture', 'community', communityId, algorithm ?? 'leiden'] as const,
    concernDetail: (repoId: string, concernId: string, algorithm?: string) =>
      ['repos', repoId, 'architecture', 'concern', concernId, algorithm ?? 'leiden'] as const,
    syncHistory: (repoId: string) =>
      ['repos', repoId, 'architecture', 'sync-history'] as const,
  },
}

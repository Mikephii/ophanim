import { queryOptions } from '@tanstack/react-query'
import {
  getDashboardStats,
  getRepoStats,
  getSecurityBreakdown,
  getSecurityDashboardStats,
} from '../api/stats'
import { queryKeys } from './keys'

export const dashboardQueries = {
  stats: () =>
    queryOptions({
      queryKey: queryKeys.dashboard.stats(),
      queryFn: () => getDashboardStats(),
    }),
}

export const statsQueries = {
  overview: (repoId: string) =>
    queryOptions({
      queryKey: queryKeys.stats.overview(repoId),
      queryFn: () => getRepoStats({ data: { repoId } }),
    }),
  securityBreakdown: (repoId: string) =>
    queryOptions({
      queryKey: queryKeys.stats.securityBreakdown(repoId),
      queryFn: () => getSecurityBreakdown({ data: { repoId } }),
    }),
  securityDashboard: (repoId: string) =>
    queryOptions({
      queryKey: queryKeys.security.dashboard(repoId),
      queryFn: () => getSecurityDashboardStats({ data: { repoId } }),
    }),
}

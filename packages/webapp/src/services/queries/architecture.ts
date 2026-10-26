import { queryOptions } from '@tanstack/react-query'
import {
  getArchitectureHierarchy,
  getCommunityDetail,
  getConcernDetail,
  getDocsSyncHistory,
} from '../api/architecture'
import { queryKeys } from './keys'

export const architectureQueries = {
  hierarchy: (repoId: string, algorithm?: string) =>
    queryOptions({
      queryKey: queryKeys.architecture.hierarchy(repoId, algorithm),
      queryFn: () =>
        getArchitectureHierarchy({ data: { repoId, algorithm } }),
    }),
  communityDetail: (
    repoId: string,
    communityId: string,
    algorithm?: string,
  ) =>
    queryOptions({
      queryKey: queryKeys.architecture.communityDetail(
        repoId,
        communityId,
        algorithm,
      ),
      queryFn: () =>
        getCommunityDetail({ data: { repoId, communityId, algorithm } }),
    }),
  concernDetail: (
    repoId: string,
    concernId: string,
    algorithm?: string,
  ) =>
    queryOptions({
      queryKey: queryKeys.architecture.concernDetail(
        repoId,
        concernId,
        algorithm,
      ),
      queryFn: () =>
        getConcernDetail({ data: { repoId, concernId, algorithm } }),
    }),
  syncHistory: (repoId: string) =>
    queryOptions({
      queryKey: queryKeys.architecture.syncHistory(repoId),
      queryFn: () => getDocsSyncHistory({ data: { repoId } }),
    }),
}

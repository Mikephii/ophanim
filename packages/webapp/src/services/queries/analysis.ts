import { queryOptions } from '@tanstack/react-query'
import {
  getEnrichedFunctions,
  getEnrichedFunction,
  getSecurityIssues,
} from '../api/analysis'
import { queryKeys } from './keys'
import type {
  FunctionFilters,
  PaginationParams,
  SecurityFilters,
} from '../api/types'

export const functionQueries = {
  list: (repoId: string, filters: FunctionFilters & PaginationParams = {}) =>
    queryOptions({
      queryKey: queryKeys.functions.list(repoId, filters),
      queryFn: () => getEnrichedFunctions({ data: { repoId, ...filters } }),
    }),
  detail: (repoId: string, contentHash: string) =>
    queryOptions({
      queryKey: queryKeys.functions.detail(repoId, contentHash),
      queryFn: () =>
        getEnrichedFunction({ data: { repoId, contentHash } }),
    }),
}

export const securityQueries = {
  issues: (
    repoId: string,
    filters: SecurityFilters & PaginationParams = {},
  ) =>
    queryOptions({
      queryKey: queryKeys.security.issues(repoId, filters),
      queryFn: () => getSecurityIssues({ data: { repoId, ...filters } }),
    }),
}

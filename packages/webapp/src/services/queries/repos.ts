import { queryOptions } from '@tanstack/react-query'
import { getRepos, getRepo } from '../api/repos'
import { queryKeys } from './keys'

export const repoQueries = {
  list: () =>
    queryOptions({
      queryKey: queryKeys.repos.list(),
      queryFn: () => getRepos(),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: queryKeys.repos.detail(id),
      queryFn: () => getRepo({ data: { id } }),
    }),
}

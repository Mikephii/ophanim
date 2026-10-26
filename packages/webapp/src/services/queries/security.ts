import { queryOptions } from '@tanstack/react-query'
import { getDismissedIssues } from '../api/security'
import { queryKeys } from './keys'

export const dismissedQueries = {
  list: (repoId: string) =>
    queryOptions({
      queryKey: queryKeys.security.dismissed(repoId),
      queryFn: () => getDismissedIssues({ data: { repoId } }),
    }),
}

import { queryOptions } from '@tanstack/react-query'
import { getUser } from '@/services/auth/auth'

export const authQueries = {
  user: () =>
    queryOptions({
      queryKey: ['auth', 'user'],
      queryFn: () => getUser(),
    }),
}

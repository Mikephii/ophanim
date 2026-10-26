import { queryKeys } from './keys'
import { getPractices } from '../api/practices'

export const practicesQueries = {
  list: (repoId: string) => ({
    queryKey: queryKeys.practices.list(repoId),
    queryFn: () => getPractices({ data: { repoId } }),
  }),
}

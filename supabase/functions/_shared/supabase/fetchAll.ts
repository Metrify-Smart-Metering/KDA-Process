// PostgREST/Supabase schneidet Selects bei max_rows (Default 1000) ab.
// Jede Seite muss deshalb neu gebaut und per range() geladen werden.
export const DEFAULT_PAGE_SIZE = 1000

type PageableQuery<T> = {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>
}

export async function fetchAllRows<T>(
  createQuery: () => PageableQuery<T>,
  options?: {
    pageSize?: number
    label?: string
  },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  const label = options?.label ?? 'Query'
  const rows: T[] = []
  let from = 0

  while (true) {
    const { data, error } = await createQuery().range(from, from + pageSize - 1)

    if (error) {
      throw new Error(`${label} konnten nicht geladen werden: ${error.message}`)
    }

    const page = data ?? []
    rows.push(...page)

    if (page.length < pageSize) break
    from += pageSize
  }

  return rows
}

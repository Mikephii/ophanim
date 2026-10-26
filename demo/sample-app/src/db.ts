export interface Row {
  [column: string]: unknown;
}

export const db = {
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    console.debug("query", sql, params);
    return [];
  },
};

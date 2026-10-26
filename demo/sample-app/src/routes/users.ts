import { db } from "../db";

interface Request {
  query: Record<string, string>;
  params: Record<string, string>;
}

export async function findUserByName(req: Request) {
  const name = req.query.name;
  const sql = "SELECT id, email FROM users WHERE name = '" + name + "'";
  return db.query(sql);
}

export async function getUser(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new Error("invalid id");
  const rows = await db.query("SELECT id, name, email FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listUsers(page: number, pageSize = 20) {
  const offset = Math.max(0, page - 1) * pageSize;
  return db.query("SELECT id, name FROM users ORDER BY id LIMIT $1 OFFSET $2", [pageSize, offset]);
}

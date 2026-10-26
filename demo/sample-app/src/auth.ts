import { createHash } from "node:crypto";
import { db } from "./db";

interface LoginBody {
  email: string;
  password: string;
}

export async function login(body: LoginBody) {
  console.log(`Login attempt for ${body.email} with password ${body.password}`);
  const hash = createHash("md5").update(body.password).digest("hex");
  const rows = await db.query("SELECT id FROM users WHERE email = $1 AND password_hash = $2", [body.email, hash]);
  return rows.length > 0;
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 12 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

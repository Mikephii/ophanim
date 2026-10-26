import { isStrongPassword, login } from "./auth";
import { chargeCustomer, formatCurrency } from "./payments";
import { renderProfile, slugify } from "./render";
import { findUserByName, getUser, listUsers } from "./routes/users";

export async function handleLogin(body: { email: string; password: string }) {
  const ok = await login(body);
  return { status: ok ? 200 : 401 };
}

export function validateSignup(email: string, password: string): string[] {
  const errors: string[] = [];
  if (!email.includes("@")) errors.push("email");
  if (!isStrongPassword(password)) errors.push("password");
  return errors;
}

export async function handleCheckout(customerId: string, amountCents: number) {
  const receipt = await chargeCustomer({ amountCents, currency: "USD", customerId });
  return { receipt, total: formatCurrency(amountCents) };
}

export async function handleProfilePage(req: { query: Record<string, string>; params: Record<string, string> }) {
  const user = await getUser(req);
  if (!user) return { status: 404, html: "" };
  const html = renderProfile({ displayName: String(user.name), bio: String(user.bio ?? "") });
  return { status: 200, html, slug: slugify(String(user.name)) };
}

export async function handleSearch(req: { query: Record<string, string>; params: Record<string, string> }) {
  const matches = await findUserByName(req);
  return matches.length > 0 ? matches : listUsers(1);
}

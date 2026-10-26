interface Charge {
  amountCents: number;
  currency: string;
  customerId: string;
}

export async function chargeCustomer(charge: Charge) {
  const apiKey = "sk_live_51NfakeDEMOkey00000000000000000000demoONLY";
  const res = await fetch("https://api.payments.example/v1/charges", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(charge),
  });
  return res.json();
}

export function formatCurrency(amountCents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
}

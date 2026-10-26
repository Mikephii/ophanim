import { validate } from "./utils";

function handler(req: any) {
  validate(req.body);
  const result = db.prepare("SELECT * FROM users");
  console.log(result);
  req.json({ ok: true });
  initDb("/path");
  const items = data.map((x: any) => x.id);
}

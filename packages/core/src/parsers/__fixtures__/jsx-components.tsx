import { Button } from "./ui/button";
import { validate } from "./utils";

export function LoginForm() {
  return (
    <div>
      <Button onClick={() => validate()}>Login</Button>
      <Card title="Hello" />
    </div>
  );
}

export function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>
      <LoginForm />
    </section>
  );
}

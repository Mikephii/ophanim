import { SECURITY_FLAG_LABELS, FLAG_TIERS } from "../utils/flag-labels";

export interface SecurityExplainer {
  flag: string;
  title: string;
  tier: number;
  cwe: string;
  owasp: string;
  whatIsIt: string;
  howItWorks: string;
  vulnerableCode: string;
  safeCode: string;
  frameworkNotes: string;
  references: { title: string; url: string }[];
}

/** CWE/OWASP metadata per flag (inlined from @ophan/core/schemas) */
const FLAG_META: Record<string, { cwe: string; owasp: string }> = {
  sql_injection: { cwe: "CWE-89", owasp: "A03:2021" },
  command_injection: { cwe: "CWE-78", owasp: "A03:2021" },
  hardcoded_secret: { cwe: "CWE-798", owasp: "A07:2021" },
  eval_exec: { cwe: "CWE-95", owasp: "A03:2021" },
  path_traversal: { cwe: "CWE-22", owasp: "A01:2021" },
  insecure_subprocess: { cwe: "CWE-78", owasp: "A03:2021" },
  unsanitized_input: { cwe: "CWE-20", owasp: "A03:2021" },
  xss: { cwe: "CWE-79", owasp: "A03:2021" },
  pickle_deserialization: { cwe: "CWE-502", owasp: "A08:2021" },
  prototype_pollution: { cwe: "CWE-1321", owasp: "A03:2021" },
};

function explainer(
  flag: string,
  content: Omit<SecurityExplainer, "flag" | "title" | "tier" | "cwe" | "owasp">,
): SecurityExplainer {
  const meta = FLAG_META[flag];
  return {
    flag,
    title: SECURITY_FLAG_LABELS[flag] ?? flag,
    tier: FLAG_TIERS[flag] ?? 3,
    cwe: meta?.cwe ?? "",
    owasp: meta?.owasp ?? "",
    ...content,
  };
}

export const SECURITY_EXPLAINERS: Record<string, SecurityExplainer> = {
  sql_injection: explainer("sql_injection", {
    whatIsIt:
      "SQL Injection occurs when user-controlled input is concatenated directly into SQL queries, allowing attackers to modify the query logic. This can lead to unauthorized data access, data modification, or complete database compromise.",
    howItWorks:
      "When a query is built by string concatenation with user input, an attacker can inject SQL syntax. For example, a login form that builds `SELECT * FROM users WHERE name = '${username}'` can be bypassed with input like `' OR 1=1 --`, which changes the query to return all users.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: String concatenation in SQL
const query = \`SELECT * FROM users WHERE id = '\${req.params.id}'\`
db.execute(query)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Parameterized query
db.query('SELECT * FROM users WHERE id = ?', [req.params.id])

// SAFE: ORM with parameterized methods
const user = await prisma.user.findUnique({ where: { id: req.params.id } })
\`\`\``,
    frameworkNotes:
      "Most ORMs (Prisma, Drizzle, TypeORM) parameterize by default. Raw query methods are the primary risk. Supabase client methods are safe; `.rpc()` depends on the function implementation.",
    references: [
      { title: "OWASP SQL Injection", url: "https://owasp.org/www-community/attacks/SQL_Injection" },
      { title: "CWE-89", url: "https://cwe.mitre.org/data/definitions/89.html" },
    ],
  }),

  command_injection: explainer("command_injection", {
    whatIsIt:
      "Command Injection occurs when user input is passed to a system shell command without proper sanitization, allowing attackers to execute arbitrary OS commands on the server.",
    howItWorks:
      "When applications use functions like `exec()`, `spawn()` with shell option, or Python's `os.system()` with user-controlled strings, attackers can inject additional commands using shell metacharacters like `;`, `&&`, `|`, or backticks.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: exec with user input
import { exec } from 'child_process'
exec(\`convert \${userFilename} output.png\`)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: execFile with argument array (no shell)
import { execFile } from 'child_process'
execFile('convert', [userFilename, 'output.png'])
\`\`\``,
    frameworkNotes:
      "Node.js `child_process.exec()` always invokes a shell; prefer `execFile()` or `spawn()` without the `shell` option. In Python, always use `subprocess.run()` with a list of arguments.",
    references: [
      { title: "OWASP Command Injection", url: "https://owasp.org/www-community/attacks/Command_Injection" },
      { title: "CWE-78", url: "https://cwe.mitre.org/data/definitions/78.html" },
    ],
  }),

  hardcoded_secret: explainer("hardcoded_secret", {
    whatIsIt:
      "Hardcoded secrets are API keys, passwords, tokens, or other credentials embedded directly in source code. When committed to version control, they become accessible to anyone with repository access.",
    howItWorks:
      "Developers sometimes hardcode credentials during development and forget to remove them. Even if removed in a later commit, the secret remains in git history. Attackers scan repositories for patterns like API keys and can use them within minutes of exposure.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: Hardcoded API key
const STRIPE_KEY = 'sk_live_abcdef1234567890'

// VULNERABLE: Hardcoded database password
const dbConfig = { password: 'super_secret_password_123' }
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Environment variable
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY

// SAFE: .env file (gitignored)
import 'dotenv/config'
const key = process.env.STRIPE_SECRET_KEY
\`\`\``,
    frameworkNotes:
      "Use environment variables (`.env` files, gitignored) for local development. In production, use your platform's secret management: Vercel Environment Variables, AWS Secrets Manager, etc.",
    references: [
      { title: "OWASP Hardcoded Credentials", url: "https://owasp.org/www-community/vulnerabilities/Use_of_hard-coded_password" },
      { title: "CWE-798", url: "https://cwe.mitre.org/data/definitions/798.html" },
    ],
  }),

  eval_exec: explainer("eval_exec", {
    whatIsIt:
      "Dynamic code execution via `eval()`, `new Function()`, or similar constructs allows arbitrary code to run at runtime. When the executed code contains user input, attackers can run any code in the application's context.",
    howItWorks:
      "Functions like `eval()` parse and execute strings as code. If user input reaches `eval()`, attackers can execute arbitrary JavaScript — reading files, making network requests, or compromising the server.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: eval with user input
const result = eval(req.body.expression)

// VULNERABLE: new Function with user input
const fn = new Function('x', req.body.formula)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Parse and validate instead of eval
const allowedOps = { add: (a, b) => a + b, sub: (a, b) => a - b }
const result = allowedOps[operation]?.(a, b)

// SAFE: JSON.parse for data (not code)
const data = JSON.parse(req.body.data)
\`\`\``,
    frameworkNotes:
      "ESLint's `no-eval` rule catches direct `eval()` usage. Content Security Policy (CSP) headers can block `eval()` in browsers. For math expressions, use libraries like `mathjs`.",
    references: [
      { title: "MDN eval() documentation", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval" },
      { title: "CWE-95", url: "https://cwe.mitre.org/data/definitions/95.html" },
    ],
  }),

  path_traversal: explainer("path_traversal", {
    whatIsIt:
      "Path Traversal occurs when user-controlled input is used to construct file paths without proper validation, allowing attackers to access files outside the intended directory using sequences like `../`.",
    howItWorks:
      "When an application serves files based on user input, an attacker can use `../` sequences to escape the intended directory: `/files?name=../../../etc/passwd`. This can expose sensitive files.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: Direct path concatenation
const filePath = path.join(uploadsDir, req.params.filename)
res.sendFile(filePath)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Resolve and validate against base directory
const base = path.resolve(uploadsDir)
const requested = path.resolve(path.join(uploadsDir, req.params.filename))
if (!requested.startsWith(base)) {
  return res.status(403).send('Access denied')
}

// SAFE: Use basename to strip directory components
const safeName = path.basename(req.params.filename)
\`\`\``,
    frameworkNotes:
      "Express `res.sendFile()` with the `root` option restricts to a base directory. For file uploads, always use `path.basename()` to strip directory components.",
    references: [
      { title: "OWASP Path Traversal", url: "https://owasp.org/www-community/attacks/Path_Traversal" },
      { title: "CWE-22", url: "https://cwe.mitre.org/data/definitions/22.html" },
    ],
  }),

  insecure_subprocess: explainer("insecure_subprocess", {
    whatIsIt:
      "Insecure subprocess execution occurs when external processes are invoked with user-controlled arguments using shell interpretation, enabling command injection through argument manipulation.",
    howItWorks:
      "Even when the command itself is hardcoded, passing user input as arguments through a shell can allow injection via shell metacharacters. The key is using `shell=True` or shell-invoking APIs when direct process execution would be safer.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: exec always uses a shell
exec(\`git clone \${repoUrl}\`)

// VULNERABLE: spawn with shell: true
spawn('git', ['clone', repoUrl], { shell: true })
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: spawn without shell
spawn('git', ['clone', repoUrl])

// SAFE: execFile with separate arguments
execFile('git', ['clone', '--depth', '1', repoUrl])
\`\`\``,
    frameworkNotes:
      "In Node.js, prefer `spawn()` or `execFile()` over `exec()`. The `execa` library provides a safe API by default.",
    references: [
      { title: "Node.js child_process docs", url: "https://nodejs.org/api/child_process.html" },
      { title: "CWE-78", url: "https://cwe.mitre.org/data/definitions/78.html" },
    ],
  }),

  unsanitized_input: explainer("unsanitized_input", {
    whatIsIt:
      "Unsanitized input refers to user-provided data that is used in security-sensitive operations without validation, encoding, or sanitization. This is a broad category encompassing the root cause of many specific vulnerabilities.",
    howItWorks:
      'When user input flows into database queries, HTML rendering, file operations, or API calls without validation, it can trigger various vulnerabilities. The principle of "never trust user input" means all external data should be validated at system boundaries.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: User input used directly in redirect
res.redirect(req.query.returnUrl)

// VULNERABLE: User input in regex (ReDoS)
const pattern = new RegExp(req.query.search)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Validate redirect URL against allowlist
const allowed = ['/dashboard', '/profile', '/settings']
const target = allowed.includes(req.query.returnUrl) ? req.query.returnUrl : '/'

// SAFE: Validate and sanitize inputs with Zod
const schema = z.object({
  subject: z.string().max(200),
})
\`\`\``,
    frameworkNotes:
      "Use Zod or similar validation libraries at API boundaries. React auto-escapes JSX interpolation. Always validate on the server, even if the client validates too.",
    references: [
      { title: "OWASP Input Validation", url: "https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html" },
      { title: "CWE-20", url: "https://cwe.mitre.org/data/definitions/20.html" },
    ],
  }),

  xss: explainer("xss", {
    whatIsIt:
      "Cross-Site Scripting (XSS) allows attackers to inject malicious scripts into web pages viewed by other users. This can lead to session hijacking, credential theft, or redirecting users to malicious sites.",
    howItWorks:
      "XSS occurs when user input is included in HTML output without proper encoding. There are three types: Stored, Reflected, and DOM-based. The attacker's script runs in the victim's browser with full access to cookies, localStorage, and the DOM.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: dangerouslySetInnerHTML with user content
<div dangerouslySetInnerHTML={{ __html: userComment }} />

// VULNERABLE: Direct DOM manipulation
element.innerHTML = userInput
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: React auto-escapes JSX expressions
<p>{userComment}</p>

// SAFE: DOMPurify for rich content
import DOMPurify from 'dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(richContent) }} />
\`\`\``,
    frameworkNotes:
      "React auto-escapes all JSX interpolation, making XSS uncommon. Main risks: `dangerouslySetInnerHTML`, `href=\"javascript:...\"`, and prop spreading on native elements.",
    references: [
      { title: "OWASP XSS Prevention", url: "https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html" },
      { title: "CWE-79", url: "https://cwe.mitre.org/data/definitions/79.html" },
    ],
  }),

  pickle_deserialization: explainer("pickle_deserialization", {
    whatIsIt:
      "Insecure deserialization occurs when an application deserializes data from untrusted sources using formats that can execute arbitrary code. Python's `pickle` module is the most common example.",
    howItWorks:
      "Python's `pickle.loads()` can execute arbitrary Python code during deserialization by design. An attacker who controls pickled data can craft a payload that executes OS commands or exfiltrates data.",
    vulnerableCode: `\`\`\`python
# VULNERABLE: Unpickling user-provided data
import pickle
data = pickle.loads(request.body)

# VULNERABLE: yaml.load with untrusted input
config = yaml.load(user_yaml)  # yaml.load can execute code
\`\`\``,
    safeCode: `\`\`\`python
# SAFE: Use JSON for data exchange
import json
data = json.loads(request.body)

# SAFE: yaml.safe_load
config = yaml.safe_load(user_yaml)

# SAFE: Use safetensors for ML models
from safetensors import safe_open
\`\`\``,
    frameworkNotes:
      "In Python ML/AI codebases, pickle is common for model serialization. Prefer `safetensors` or ONNX for model exchange. For data, use JSON or MessagePack.",
    references: [
      { title: "OWASP Deserialization", url: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/16-Testing_for_HTTP_Incoming_Requests" },
      { title: "CWE-502", url: "https://cwe.mitre.org/data/definitions/502.html" },
    ],
  }),

  prototype_pollution: explainer("prototype_pollution", {
    whatIsIt:
      "Prototype Pollution is a JavaScript-specific vulnerability where an attacker can modify the prototype of base objects (`Object.prototype`), affecting all objects in the application.",
    howItWorks:
      "If an attacker can set `Object.prototype.isAdmin = true`, every object in the application will have `isAdmin === true`. This typically exploits deep merge or clone functions that don't guard against `__proto__` or `constructor.prototype` keys.",
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: Naive deep merge
function merge(target, source) {
  for (const key in source) {
    if (typeof source[key] === 'object') {
      target[key] = merge(target[key] || {}, source[key])
    } else {
      target[key] = source[key]
    }
  }
}
// Attacker sends: { "__proto__": { "isAdmin": true } }
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Guard against prototype keys
function safeMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor') continue
    // ... merge logic
  }
}

// SAFE: Use Map instead of plain objects
const userSettings = new Map()
\`\`\``,
    frameworkNotes:
      "Modern versions of lodash and jQuery have fixed prototype pollution. The risk primarily comes from custom deep-merge implementations or outdated library versions.",
    references: [
      { title: "Prototype Pollution explained", url: "https://learn.snyk.io/lesson/prototype-pollution/" },
      { title: "CWE-1321", url: "https://cwe.mitre.org/data/definitions/1321.html" },
    ],
  }),
};

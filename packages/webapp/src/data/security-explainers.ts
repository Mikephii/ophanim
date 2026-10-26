import {
  SECURITY_FLAG_LABELS,
  SECURITY_FLAG_META,
} from '@ophan/core/schemas'

export interface SecurityExplainer {
  flag: string
  title: string
  tier: number
  cwe: string
  owasp: string
  whatIsIt: string
  howItWorks: string
  vulnerableCode: string
  safeCode: string
  frameworkNotes: string
  references: { title: string; url: string }[]
}

function explainer(
  flag: string,
  content: Omit<SecurityExplainer, 'flag' | 'title' | 'tier' | 'cwe' | 'owasp'>,
): SecurityExplainer {
  const meta = SECURITY_FLAG_META[flag]
  return {
    flag,
    title: SECURITY_FLAG_LABELS[flag] ?? flag,
    tier: meta?.tier ?? 3,
    cwe: meta?.cwe ?? '',
    owasp: meta?.owasp ?? '',
    ...content,
  }
}

export const SECURITY_EXPLAINERS: Record<string, SecurityExplainer> = {
  sql_injection: explainer('sql_injection', {
    whatIsIt:
      'SQL Injection occurs when user-controlled input is concatenated directly into SQL queries, allowing attackers to modify the query logic. This can lead to unauthorized data access, data modification, or complete database compromise.',
    howItWorks:
      'When a query is built by string concatenation with user input, an attacker can inject SQL syntax. For example, a login form that builds `SELECT * FROM users WHERE name = \'${username}\'` can be bypassed with input like `\' OR 1=1 --`, which changes the query to return all users. More destructive payloads can `DROP TABLE`, extract data via `UNION SELECT`, or execute OS commands via database-specific functions.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: String concatenation in SQL
const query = \`SELECT * FROM users WHERE id = '\${req.params.id}'\`
db.execute(query)

// VULNERABLE: Template literal in query
db.query(\`DELETE FROM orders WHERE user_id = \${userId}\`)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Parameterized query
db.query('SELECT * FROM users WHERE id = ?', [req.params.id])

// SAFE: ORM with parameterized methods
const user = await prisma.user.findUnique({ where: { id: req.params.id } })

// SAFE: Query builder with bound parameters
const result = await knex('users').where('id', req.params.id)
\`\`\``,
    frameworkNotes:
      'Most ORMs (Prisma, Drizzle, TypeORM, Sequelize) parameterize by default. Raw query methods (`$queryRaw`, `sequelize.query`) are the primary risk. Knex parameterizes `.where()` calls but raw `.whereRaw()` does not. Supabase client methods are safe; `.rpc()` depends on the function implementation.',
    references: [
      { title: 'OWASP SQL Injection', url: 'https://owasp.org/www-community/attacks/SQL_Injection' },
      { title: 'CWE-89', url: 'https://cwe.mitre.org/data/definitions/89.html' },
    ],
  }),

  command_injection: explainer('command_injection', {
    whatIsIt:
      'Command Injection occurs when user input is passed to a system shell command without proper sanitization, allowing attackers to execute arbitrary OS commands on the server.',
    howItWorks:
      'When applications use functions like `exec()`, `spawn()` with shell option, or Python\'s `os.system()` with user-controlled strings, attackers can inject additional commands using shell metacharacters like `;`, `&&`, `|`, or backticks. For example, a filename input of `file.txt; rm -rf /` would delete files on the server.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: exec with user input
import { exec } from 'child_process'
exec(\`convert \${userFilename} output.png\`)

// VULNERABLE: shell: true with spawn
spawn('sh', ['-c', \`grep \${searchTerm} logs.txt\`])
\`\`\`

\`\`\`python
# VULNERABLE: os.system with user input
os.system(f"convert {filename} output.png")

# VULNERABLE: subprocess with shell=True
subprocess.run(f"grep {search} logs.txt", shell=True)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: execFile with argument array (no shell)
import { execFile } from 'child_process'
execFile('convert', [userFilename, 'output.png'])

// SAFE: spawn without shell option
spawn('grep', [searchTerm, 'logs.txt'])
\`\`\`

\`\`\`python
# SAFE: subprocess with argument list (no shell)
subprocess.run(['convert', filename, 'output.png'])

# SAFE: shlex.quote for unavoidable shell usage
subprocess.run(f"grep {shlex.quote(search)} logs.txt", shell=True)
\`\`\``,
    frameworkNotes:
      'Node.js `child_process.exec()` always invokes a shell; prefer `execFile()` or `spawn()` without the `shell` option. In Python, always use `subprocess.run()` with a list of arguments and `shell=False` (the default). The `shlex.quote()` function can sanitize individual arguments when shell usage is unavoidable.',
    references: [
      { title: 'OWASP Command Injection', url: 'https://owasp.org/www-community/attacks/Command_Injection' },
      { title: 'CWE-78', url: 'https://cwe.mitre.org/data/definitions/78.html' },
    ],
  }),

  hardcoded_secret: explainer('hardcoded_secret', {
    whatIsIt:
      'Hardcoded secrets are API keys, passwords, tokens, or other credentials embedded directly in source code. When committed to version control, they become accessible to anyone with repository access and are very difficult to fully revoke.',
    howItWorks:
      'Developers sometimes hardcode credentials during development or testing and forget to remove them. Even if removed in a later commit, the secret remains in git history. Attackers scan public repositories for patterns like API keys and can use them within minutes of exposure. Secret scanners also detect these patterns in private repositories.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: Hardcoded API key
const STRIPE_KEY = 'sk_live_abcdef1234567890'

// VULNERABLE: Hardcoded database password
const dbConfig = {
  host: 'db.example.com',
  password: 'super_secret_password_123',
}

// VULNERABLE: Hardcoded JWT secret
const JWT_SECRET = 'my-jwt-secret-key-do-not-share'
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Environment variable
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY

// SAFE: Secret manager
const password = await secretManager.getSecret('db-password')

// SAFE: .env file (gitignored)
// .env: STRIPE_SECRET_KEY=sk_live_...
// .gitignore: .env
import 'dotenv/config'
const key = process.env.STRIPE_SECRET_KEY
\`\`\``,
    frameworkNotes:
      'Use environment variables (`.env` files, gitignored) for local development. In production, use your platform\'s secret management: Vercel Environment Variables, AWS Secrets Manager, GCP Secret Manager, or HashiCorp Vault. Next.js, Remix, and TanStack Start all support `.env` files natively. Never commit `.env` files — add them to `.gitignore`.',
    references: [
      { title: 'OWASP Hardcoded Credentials', url: 'https://owasp.org/www-community/vulnerabilities/Use_of_hard-coded_password' },
      { title: 'CWE-798', url: 'https://cwe.mitre.org/data/definitions/798.html' },
    ],
  }),

  eval_exec: explainer('eval_exec', {
    whatIsIt:
      'Dynamic code execution via `eval()`, `new Function()`, or similar constructs allows arbitrary code to run at runtime. When the executed code contains user input, attackers can run any code in the application\'s context.',
    howItWorks:
      'Functions like `eval()` parse and execute strings as code. If user input reaches `eval()`, attackers can execute arbitrary JavaScript — reading files, making network requests, or compromising the server. Even without direct user input, `eval()` bypasses static analysis and Content Security Policies.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: eval with user input
const result = eval(req.body.expression)

// VULNERABLE: new Function with user input
const fn = new Function('x', req.body.formula)

// VULNERABLE: setTimeout with string argument
setTimeout(userInput, 1000)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Parse and validate instead of eval
const allowedOps = { add: (a, b) => a + b, sub: (a, b) => a - b }
const result = allowedOps[operation]?.(a, b)

// SAFE: Use a safe expression parser
import { evaluate } from 'mathjs'
const result = evaluate(expression) // sandboxed math only

// SAFE: JSON.parse for data (not code)
const data = JSON.parse(req.body.data)
\`\`\``,
    frameworkNotes:
      'ESLint\'s `no-eval` rule catches direct `eval()` usage. Content Security Policy (CSP) headers can block `eval()` in browsers. For math expressions, use libraries like `mathjs` with sandboxed evaluation. For template rendering, use established template engines (Handlebars, EJS) rather than string interpolation with `eval()`.',
    references: [
      { title: 'MDN eval() documentation', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval' },
      { title: 'CWE-95', url: 'https://cwe.mitre.org/data/definitions/95.html' },
    ],
  }),

  path_traversal: explainer('path_traversal', {
    whatIsIt:
      'Path Traversal (Directory Traversal) occurs when user-controlled input is used to construct file paths without proper validation, allowing attackers to access files outside the intended directory using sequences like `../`.',
    howItWorks:
      'When an application serves files based on user input (e.g., `GET /files?name=report.pdf`), an attacker can use `../` sequences to escape the intended directory: `/files?name=../../../etc/passwd`. This can expose sensitive files like configuration, credentials, or application source code.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: Direct path concatenation
const filePath = path.join(uploadsDir, req.params.filename)
res.sendFile(filePath)

// VULNERABLE: No traversal check
app.get('/docs/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', req.params.name))
})
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Resolve and validate against base directory
const base = path.resolve(uploadsDir)
const requested = path.resolve(path.join(uploadsDir, req.params.filename))
if (!requested.startsWith(base)) {
  return res.status(403).send('Access denied')
}
res.sendFile(requested)

// SAFE: Use basename to strip directory components
const safeName = path.basename(req.params.filename)
res.sendFile(path.join(uploadsDir, safeName))

// SAFE: Allowlist of valid files
const VALID_DOCS = ['guide.pdf', 'api.pdf', 'faq.pdf']
if (!VALID_DOCS.includes(req.params.name)) {
  return res.status(404).send('Not found')
}
\`\`\``,
    frameworkNotes:
      'Express `res.sendFile()` with the `root` option restricts to a base directory. Next.js static file serving from `/public` is safe by default. For file upload handling, always use `path.basename()` to strip directory components from uploaded filenames. Cloud storage (S3, GCS) eliminates server-side path traversal risk entirely.',
    references: [
      { title: 'OWASP Path Traversal', url: 'https://owasp.org/www-community/attacks/Path_Traversal' },
      { title: 'CWE-22', url: 'https://cwe.mitre.org/data/definitions/22.html' },
    ],
  }),

  insecure_subprocess: explainer('insecure_subprocess', {
    whatIsIt:
      'Insecure subprocess execution occurs when external processes are invoked with user-controlled arguments using shell interpretation, enabling command injection through argument manipulation.',
    howItWorks:
      'This is closely related to command injection but specifically targets subprocess APIs. Even when the command itself is hardcoded, passing user input as arguments through a shell can allow injection via shell metacharacters. The key distinction is using `shell=True` or shell-invoking APIs when direct process execution would be safer.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: exec always uses a shell
exec(\`git clone \${repoUrl}\`)

// VULNERABLE: spawn with shell: true
spawn('git', ['clone', repoUrl], { shell: true })
\`\`\`

\`\`\`python
# VULNERABLE: shell=True with user input
subprocess.run(f"pip install {package_name}", shell=True)

# VULNERABLE: os.popen
os.popen(f"wc -l {filename}")
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: spawn without shell (arguments are not interpreted)
spawn('git', ['clone', repoUrl])

// SAFE: execFile with separate arguments
execFile('git', ['clone', '--depth', '1', repoUrl])
\`\`\`

\`\`\`python
# SAFE: argument list without shell
subprocess.run(['pip', 'install', package_name])

# SAFE: pathlib for file operations instead of shell commands
line_count = len(Path(filename).read_text().splitlines())
\`\`\``,
    frameworkNotes:
      'In Node.js, prefer `spawn()` or `execFile()` over `exec()`. The `execa` library provides a safe API by default. In Python, `subprocess.run()` with a list and `shell=False` is safe. Consider whether you need an external process at all — many shell operations have native equivalents (`fs` for file operations, `glob` for file matching).',
    references: [
      { title: 'Node.js child_process docs', url: 'https://nodejs.org/api/child_process.html' },
      { title: 'CWE-78', url: 'https://cwe.mitre.org/data/definitions/78.html' },
    ],
  }),

  unsanitized_input: explainer('unsanitized_input', {
    whatIsIt:
      'Unsanitized input refers to user-provided data that is used in security-sensitive operations without validation, encoding, or sanitization. This is a broad category that encompasses the root cause of many specific vulnerabilities.',
    howItWorks:
      'When user input flows into operations like database queries, HTML rendering, file operations, or API calls without being validated or sanitized, it can trigger various vulnerabilities depending on the context. The principle of "never trust user input" means all external data should be validated at system boundaries.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: User input used directly in redirect
res.redirect(req.query.returnUrl)

// VULNERABLE: User input in email header
sendEmail({ to: userEmail, subject: req.body.subject })

// VULNERABLE: User input in regex (ReDoS)
const pattern = new RegExp(req.query.search)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Validate redirect URL against allowlist
const allowed = ['/dashboard', '/profile', '/settings']
const target = allowed.includes(req.query.returnUrl) ? req.query.returnUrl : '/'
res.redirect(target)

// SAFE: Validate and sanitize inputs
import { z } from 'zod'
const schema = z.object({
  subject: z.string().max(200).regex(/^[\\w\\s.,!?-]+$/),
})
const { subject } = schema.parse(req.body)

// SAFE: Escape regex special characters
const escaped = req.query.search.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
const pattern = new RegExp(escaped)
\`\`\``,
    frameworkNotes:
      'Use Zod or similar validation libraries at API boundaries. React auto-escapes JSX interpolation, protecting against XSS. TanStack Router validates search params. Express middleware like `express-validator` provides declarative input validation. Always validate on the server, even if the client validates too.',
    references: [
      { title: 'OWASP Input Validation', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html' },
      { title: 'CWE-20', url: 'https://cwe.mitre.org/data/definitions/20.html' },
    ],
  }),

  xss: explainer('xss', {
    whatIsIt:
      'Cross-Site Scripting (XSS) allows attackers to inject malicious scripts into web pages viewed by other users. This can lead to session hijacking, credential theft, defacement, or redirecting users to malicious sites.',
    howItWorks:
      'XSS occurs when user input is included in HTML output without proper encoding. There are three types: Stored (persisted in database, affects all viewers), Reflected (in URL parameters, affects users who click a crafted link), and DOM-based (manipulated client-side via JavaScript). The attacker\'s script runs in the victim\'s browser with full access to cookies, localStorage, and the DOM.',
    vulnerableCode: `\`\`\`typescript
// VULNERABLE: dangerouslySetInnerHTML with user content
<div dangerouslySetInnerHTML={{ __html: userComment }} />

// VULNERABLE: Direct DOM manipulation
element.innerHTML = userInput

// VULNERABLE: Server-side HTML without encoding
res.send(\`<p>Welcome, \${username}</p>\`)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: React auto-escapes JSX expressions
<p>{userComment}</p>

// SAFE: textContent instead of innerHTML
element.textContent = userInput

// SAFE: DOMPurify for rich content
import DOMPurify from 'dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(richContent) }} />

// SAFE: Markdown renderer with sanitization
import ReactMarkdown from 'react-markdown'
<ReactMarkdown>{userMarkdown}</ReactMarkdown>
\`\`\``,
    frameworkNotes:
      'React auto-escapes all JSX interpolation (`{value}`), making XSS in React apps uncommon. The main risks are `dangerouslySetInnerHTML`, `href="javascript:..."` in links, and prop spreading on native elements. Prop spreading (e.g., `<div {...props}>`) is typically safe in practice — it\'s a code quality concern rather than a real XSS vector. For rich text display, use DOMPurify or a markdown renderer.',
    references: [
      { title: 'OWASP XSS Prevention', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html' },
      { title: 'CWE-79', url: 'https://cwe.mitre.org/data/definitions/79.html' },
    ],
  }),

  pickle_deserialization: explainer('pickle_deserialization', {
    whatIsIt:
      'Insecure deserialization occurs when an application deserializes data from untrusted sources using formats that can execute arbitrary code during deserialization. Python\'s `pickle` module is the most common example.',
    howItWorks:
      'Python\'s `pickle.loads()` can execute arbitrary Python code during deserialization by design. An attacker who controls pickled data can craft a payload that executes OS commands, installs backdoors, or exfiltrates data. Similar risks exist with Java\'s `ObjectInputStream`, Ruby\'s `Marshal.load()`, and PHP\'s `unserialize()`.',
    vulnerableCode: `\`\`\`python
# VULNERABLE: Unpickling user-provided data
import pickle
data = pickle.loads(request.body)

# VULNERABLE: Loading pickle from untrusted file
with open(uploaded_file, 'rb') as f:
    model = pickle.load(f)

# VULNERABLE: yaml.load with untrusted input
import yaml
config = yaml.load(user_yaml)  # yaml.load can execute code
\`\`\``,
    safeCode: `\`\`\`python
# SAFE: Use JSON for data exchange
import json
data = json.loads(request.body)

# SAFE: Use safetensors for ML models
from safetensors import safe_open
model = safe_open(model_path, framework="pt")

# SAFE: yaml.safe_load
config = yaml.safe_load(user_yaml)

# SAFE: Restricted unpickler (if pickle is unavoidable)
class RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "builtins" and name in ("int", "float", "str"):
            return getattr(builtins, name)
        raise pickle.UnpicklingError(f"Forbidden: {module}.{name}")
\`\`\``,
    frameworkNotes:
      'In Python ML/AI codebases, pickle is common for model serialization. Prefer `safetensors` (Hugging Face) or ONNX for model exchange. For data, use JSON or MessagePack. Django\'s signed cookies prevent tampering but still use pickle internally — consider JSON serializer. Flask uses `itsdangerous` for safe cookie serialization.',
    references: [
      { title: 'OWASP Deserialization', url: 'https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/16-Testing_for_HTTP_Incoming_Requests' },
      { title: 'CWE-502', url: 'https://cwe.mitre.org/data/definitions/502.html' },
    ],
  }),

  prototype_pollution: explainer('prototype_pollution', {
    whatIsIt:
      'Prototype Pollution is a JavaScript-specific vulnerability where an attacker can modify the prototype of base objects (`Object.prototype`), affecting all objects in the application. This can lead to property injection, logic bypasses, or in rare cases, remote code execution.',
    howItWorks:
      'JavaScript objects inherit properties from their prototype chain. If an attacker can set `Object.prototype.isAdmin = true`, then every object in the application will have `isAdmin === true` unless it explicitly defines its own `isAdmin` property. This typically exploits deep merge, clone, or extend functions that don\'t guard against `__proto__` or `constructor.prototype` keys.',
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
  return target
}
// Attacker sends: { "__proto__": { "isAdmin": true } }
merge({}, userInput)
\`\`\``,
    safeCode: `\`\`\`typescript
// SAFE: Guard against prototype keys
function safeMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    // ... merge logic
  }
}

// SAFE: Use Object.create(null) for key-value maps
const config = Object.create(null)

// SAFE: Use Map instead of plain objects
const userSettings = new Map()

// SAFE: Use well-tested libraries
import { merge } from 'lodash' // fixed since v4.17.21
\`\`\``,
    frameworkNotes:
      'Modern versions of lodash, jQuery, and other utility libraries have fixed prototype pollution in their merge/extend functions. The risk primarily comes from custom deep-merge implementations or outdated library versions. In React/Node apps, this is rarely exploitable for RCE — it\'s more commonly a logic bypass concern. `Object.assign()` with internal data is safe because it only copies own enumerable properties.',
    references: [
      { title: 'Prototype Pollution explained', url: 'https://learn.snyk.io/lesson/prototype-pollution/' },
      { title: 'CWE-1321', url: 'https://cwe.mitre.org/data/definitions/1321.html' },
    ],
  }),
}

import { Plugin } from "vite";
import fs from "fs";
import path from "path";

// This plugin serves .ophan/index.db files during development
// Usage: http://localhost:5173?repo=/path/to/your/project
export function serveOphanDb(): Plugin {
  return {
    name: "serve-ophan-db",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Handle requests for the db file
        if (req.url?.startsWith("/__ophan_db")) {
          const url = new URL(req.url, "http://localhost");
          const repoPath = url.searchParams.get("repo");

          if (!repoPath) {
            res.statusCode = 400;
            res.end("Missing repo param");
            return;
          }

          // hmmm

          //
          const dbPath = path.join(repoPath, ".ophan", "index.db");

          if (!fs.existsSync(dbPath)) {
            res.statusCode = 404;
            res.end(`No .ophan/index.db found at ${repoPath}`);
            return;
          }

          const dbBuffer = fs.readFileSync(dbPath);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(dbBuffer);
          return;
        }

        next();
      });
    },
  };
}

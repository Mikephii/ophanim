import Database from "better-sqlite3";

/**
 * Creates an in-memory SQLite database with the current ophan schema.
 * Use for merge, import, GC, and findMissingHashes tests.
 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE function_analysis (
      content_hash TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      analysis JSON NOT NULL,
      model_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      synced_at INTEGER,
      PRIMARY KEY (content_hash, analysis_type)
    )
  `);

  db.exec(`
    CREATE TABLE file_functions (
      file_path TEXT NOT NULL,
      function_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      start_line INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (file_path, function_name)
    )
  `);

  db.exec(`
    CREATE TABLE function_gc (
      content_hash TEXT NOT NULL,
      analysis_type TEXT,
      gc_at INTEGER NOT NULL,
      synced_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE practices (
      practice_id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning'
    )
  `);

  db.exec(
    "CREATE INDEX idx_file_functions_path ON file_functions(file_path)"
  );
  db.exec(
    "CREATE INDEX idx_file_functions_hash ON file_functions(content_hash)"
  );

  // Graph analysis tables
  db.exec(`
    CREATE TABLE function_edges (
      source_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source_hash, target_hash, edge_type)
    )
  `);

  db.exec(`
    CREATE TABLE communities (
      content_hash TEXT NOT NULL,
      level INTEGER NOT NULL,
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      PRIMARY KEY (content_hash, level, algorithm)
    )
  `);

  db.exec(`
    CREATE TABLE community_summaries (
      community_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      input_hash TEXT NOT NULL,
      summary JSON NOT NULL,
      model_version TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, level, algorithm)
    )
  `);

  db.exec(`
    CREATE TABLE graph_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE community_edges (
      source_community TEXT NOT NULL,
      target_community TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      weight REAL NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_community, target_community, algorithm)
    )
  `);

  db.exec(`
    CREATE TABLE community_signatures (
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      signatures JSON NOT NULL,
      PRIMARY KEY (community_id, algorithm)
    )
  `);

  db.exec("CREATE INDEX idx_edges_source ON function_edges(source_hash)");
  db.exec("CREATE INDEX idx_edges_target ON function_edges(target_hash)");
  db.exec("CREATE INDEX idx_communities_id ON communities(community_id)");
  db.exec("CREATE INDEX idx_ce_source ON community_edges(source_community)");
  db.exec("CREATE INDEX idx_ce_target ON community_edges(target_community)");

  return db;
}

/**
 * Creates an in-memory DB with the OLD (pre-analysis-type) schema.
 * Used to test migrateToAnalysisTypes().
 */
export function createLegacyTestDb(): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE function_analysis (
      content_hash TEXT PRIMARY KEY,
      analysis JSON NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      language TEXT,
      entity_type TEXT,
      synced_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE file_functions (
      file_path TEXT NOT NULL,
      function_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      PRIMARY KEY (file_path, function_name)
    )
  `);

  db.exec(`
    CREATE TABLE function_gc (
      content_hash TEXT NOT NULL,
      gc_at INTEGER NOT NULL,
      synced_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return db;
}

/** Returns JSON string for a documentation analysis payload. */
export function makeDocAnalysisJson(
  overrides: Partial<{
    description: string;
    params: { name: string; type: string; description: string }[];
    returns: { type: string; description: string };
  }> = {}
): string {
  return JSON.stringify({
    description: overrides.description ?? "Test function description",
    params: overrides.params ?? [
      { name: "x", type: "number", description: "input" },
    ],
    returns: overrides.returns ?? { type: "number", description: "output" },
  });
}

/** Returns JSON string for a security analysis payload. */
export function makeSecAnalysisJson(
  overrides: Partial<{
    dataTags: string[];
    securityFlags: string[];
    issues: { flag: string; title: string; description: string; explanation: string; line: number; startText: string; endText: string; severity: string }[];
  }> = {}
): string {
  return JSON.stringify({
    dataTags: overrides.dataTags ?? ["internal"],
    securityFlags: overrides.securityFlags ?? [],
    issues: overrides.issues ?? [],
  });
}

/** Inserts a matched pair of documentation + security rows for a content_hash. */
export function insertAnalysisPair(
  db: Database.Database,
  contentHash: string,
  options: {
    language?: string;
    entityType?: string;
    syncedAt?: number | null;
    lastSeenAt?: number;
    createdAt?: number;
    doc?: Parameters<typeof makeDocAnalysisJson>[0];
    sec?: Parameters<typeof makeSecAnalysisJson>[0];
    schemaVersion?: { doc?: number; sec?: number };
  } = {}
): void {
  const now = Math.floor(Date.now() / 1000);
  const language = options.language ?? "typescript";
  const entityType = options.entityType ?? "function";
  const createdAt = options.createdAt ?? now;
  const lastSeenAt = options.lastSeenAt ?? now;
  const syncedAt = options.syncedAt ?? null;
  const docVersion = options.schemaVersion?.doc ?? 1;
  const secVersion = options.schemaVersion?.sec ?? 1;

  db.prepare(
    `INSERT OR REPLACE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    VALUES (?, 'documentation', ?, 'test-model', ?, ?, ?, ?, ?, ?)`
  ).run(
    contentHash,
    makeDocAnalysisJson(options.doc),
    docVersion,
    createdAt,
    lastSeenAt,
    language,
    entityType,
    syncedAt
  );

  db.prepare(
    `INSERT OR REPLACE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    VALUES (?, 'security', ?, 'test-model', ?, ?, ?, ?, ?, ?)`
  ).run(
    contentHash,
    makeSecAnalysisJson(options.sec),
    secVersion,
    createdAt,
    lastSeenAt,
    language,
    entityType,
    syncedAt
  );
}

/** Returns JSON string for a practices analysis payload. */
export function makePracAnalysisJson(
  overrides: Partial<{
    violations: { flag: string; title: string; description: string; explanation: string; line: number; startText: string; endText: string; severity: string }[];
  }> = {}
): string {
  return JSON.stringify({
    violations: overrides.violations ?? [],
  });
}

/** Inserts a practices analysis row for a content_hash. */
export function insertPracticesRow(
  db: Database.Database,
  contentHash: string,
  options: {
    language?: string;
    entityType?: string;
    syncedAt?: number | null;
    lastSeenAt?: number;
    createdAt?: number;
    prac?: Parameters<typeof makePracAnalysisJson>[0];
  } = {}
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    VALUES (?, 'practices', ?, 'test-model', 1, ?, ?, ?, ?, ?)`
  ).run(
    contentHash,
    makePracAnalysisJson(options.prac),
    options.createdAt ?? now,
    options.lastSeenAt ?? now,
    options.language ?? "typescript",
    options.entityType ?? "function",
    options.syncedAt ?? null
  );
}

/** Inserts a community assignment row. */
export function insertCommunity(
  db: Database.Database,
  contentHash: string,
  communityId: string,
  options: {
    level?: number;
    algorithm?: string;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO communities (content_hash, level, community_id, algorithm)
    VALUES (?, ?, ?, ?)`
  ).run(
    contentHash,
    options.level ?? 0,
    communityId,
    options.algorithm ?? "louvain"
  );
}

/** Inserts a function edge. */
export function insertEdge(
  db: Database.Database,
  sourceHash: string,
  targetHash: string,
  options: {
    edgeType?: string;
    weight?: number;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO function_edges (source_hash, target_hash, edge_type, weight)
    VALUES (?, ?, ?, ?)`
  ).run(
    sourceHash,
    targetHash,
    options.edgeType ?? "call",
    options.weight ?? 1.0
  );
}

/** Inserts a community summary row. */
export function insertCommunitySummary(
  db: Database.Database,
  communityId: string,
  options: {
    level?: number;
    algorithm?: string;
    inputHash?: string;
    summary?: object;
    modelVersion?: string;
  } = {}
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO community_summaries
    (community_id, level, algorithm, input_hash, summary, model_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    communityId,
    options.level ?? 1,
    options.algorithm ?? "louvain",
    options.inputHash ?? "test-input-hash",
    JSON.stringify(options.summary ?? { title: "Test", documentation: "# Test", meta: {} }),
    options.modelVersion ?? "test-model",
    now
  );
}

/** Inserts a file_functions row. */
export function insertFileFunction(
  db: Database.Database,
  filePath: string,
  functionName: string,
  contentHash: string,
  options: {
    mtime?: number;
    language?: string;
    entityType?: string;
    startLine?: number;
  } = {}
): void {
  db.prepare(
    `INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language, entity_type, start_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    filePath,
    functionName,
    contentHash,
    options.mtime ?? Date.now(),
    options.language ?? "typescript",
    options.entityType ?? "function",
    options.startLine ?? 0
  );
}

/** Inserts a community_edges row. */
export function insertCommunityEdge(
  db: Database.Database,
  sourceCommunity: string,
  targetCommunity: string,
  options: {
    algorithm?: string;
    weight?: number;
    edgeCount?: number;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO community_edges (source_community, target_community, algorithm, weight, edge_count)
    VALUES (?, ?, ?, ?, ?)`
  ).run(
    sourceCommunity,
    targetCommunity,
    options.algorithm ?? "louvain",
    options.weight ?? 1.0,
    options.edgeCount ?? 1
  );
}

-- Migration 00002: Split analysis into types (documentation, security)
--
-- Before: One row per (content_hash, repo_id) with a monolithic analysis JSONB blob
-- After:  Two rows per function -- 'documentation' and 'security' -- each with focused JSONB
--
-- This enables:
--   - Independent versioning (bump security schema without re-running doc analysis)
--   - Selective re-analysis (re-run security only when new detectors are added)
--   - Extensibility (add 'complexity', 'testing', etc. without changing existing rows)
--   - Smaller JSONB payloads per row (better for partial reads)
--
-- See docs/architecture/analysis-types.md for design rationale.

BEGIN;

-- ============================================================================
-- 1. FUNCTION_ANALYSIS -- Add analysis_type + schema_version
-- ============================================================================

-- Create new table with analysis_type in the primary key
CREATE TABLE public.function_analysis_v2 (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,              -- 'documentation' | 'security'
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  analysis JSONB NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  -- Generated columns: harmless on doc rows (empty arrays), meaningful on security rows
  security_flag_count INTEGER GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb))
  ) STORED,
  has_security_flags BOOLEAN GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb)) > 0
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, repo_id, analysis_type)
);

-- Split existing rows: documentation
INSERT INTO public.function_analysis_v2
  (content_hash, analysis_type, repo_id, user_id, analysis, model_version,
   schema_version, language, entity_type, created_at, synced_at)
SELECT
  content_hash,
  'documentation',
  repo_id,
  user_id,
  jsonb_build_object(
    'description', COALESCE(analysis->'description', '""'::jsonb),
    'params',      COALESCE(analysis->'params', '[]'::jsonb),
    'returns',     COALESCE(analysis->'returns', '{"type":"unknown","description":""}'::jsonb)
  ),
  model_version,
  1,
  language,
  entity_type,
  created_at,
  synced_at
FROM public.function_analysis;

-- Split existing rows: security
INSERT INTO public.function_analysis_v2
  (content_hash, analysis_type, repo_id, user_id, analysis, model_version,
   schema_version, language, entity_type, created_at, synced_at)
SELECT
  content_hash,
  'security',
  repo_id,
  user_id,
  jsonb_build_object(
    'dataTags',      COALESCE(analysis->'dataTags', '[]'::jsonb),
    'securityFlags', COALESCE(analysis->'securityFlags', '[]'::jsonb)
  ),
  model_version,
  1,
  language,
  entity_type,
  created_at,
  synced_at
FROM public.function_analysis;

-- Swap tables
DROP TABLE public.function_analysis;
ALTER TABLE public.function_analysis_v2 RENAME TO function_analysis;

-- ============================================================================
-- 2. FUNCTION_GC -- Add analysis_type column
-- ============================================================================

-- Recreate as a processing queue (rows are deleted after sync)
DROP TABLE public.function_gc;

CREATE TABLE public.function_gc (
  content_hash TEXT NOT NULL,
  analysis_type TEXT,                       -- NULL = delete all types for this hash
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  gc_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. INDEXES
-- ============================================================================

-- Security querying: GIN index on security analysis
CREATE INDEX idx_fa_security_flags ON public.function_analysis
  USING GIN ((analysis->'securityFlags'))
  WHERE analysis_type = 'security';

CREATE INDEX idx_fa_data_tags ON public.function_analysis
  USING GIN ((analysis->'dataTags'))
  WHERE analysis_type = 'security';

-- Security count queries
CREATE INDEX idx_fa_security_count ON public.function_analysis
  (repo_id, security_flag_count DESC)
  WHERE analysis_type = 'security' AND has_security_flags = true;

-- Repo-scoped lookups
CREATE INDEX idx_fa_repo ON public.function_analysis (repo_id);
CREATE INDEX idx_fa_repo_type ON public.function_analysis (repo_id, analysis_type);
CREATE INDEX idx_fa_hash ON public.function_analysis (content_hash);

-- GC queue
CREATE INDEX idx_gc_repo ON public.function_gc (repo_id);

-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.function_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.function_gc ENABLE ROW LEVEL SECURITY;

-- Function analysis: CRUD own data
CREATE POLICY "fa_select_own" ON public.function_analysis
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "fa_insert_own" ON public.function_analysis
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "fa_update_own" ON public.function_analysis
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "fa_delete_own" ON public.function_analysis
  FOR DELETE USING (user_id = auth.uid());

-- Function GC: CRUD own data
CREATE POLICY "gc_select_own" ON public.function_gc
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "gc_insert_own" ON public.function_gc
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "gc_delete_own" ON public.function_gc
  FOR DELETE USING (user_id = auth.uid());

COMMIT;

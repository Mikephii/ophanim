-- Migration 00003: Community summaries + membership tables
--
-- Adds cloud storage for graph community detection results and
-- hierarchical LLM-generated documentation summaries.
--
-- Two tables:
--   - community_summaries: Cached L1/L2/L3 documentation (upserted on sync)
--   - communities: Function-to-community membership (full-replaced on sync)
--
-- See docs/architecture/auto-docs.md for design rationale.

BEGIN;

-- ============================================================================
-- 1. COMMUNITY_SUMMARIES -- Hierarchical documentation
-- ============================================================================

CREATE TABLE public.community_summaries (
  community_id TEXT NOT NULL,
  level INTEGER NOT NULL,                -- 1=subsystem, 2=system, 3=architecture
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,              -- SHA256 of sorted member hashes (cache key)
  summary JSONB NOT NULL,                -- { title, documentation, meta }
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, level, algorithm, repo_id)
);

CREATE INDEX idx_cs_repo ON public.community_summaries (repo_id);
CREATE INDEX idx_cs_repo_level ON public.community_summaries (repo_id, level);

ALTER TABLE public.community_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cs_select_own" ON public.community_summaries
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "cs_insert_own" ON public.community_summaries
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "cs_update_own" ON public.community_summaries
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "cs_delete_own" ON public.community_summaries
  FOR DELETE USING (user_id = auth.uid());

-- ============================================================================
-- 2. COMMUNITIES -- Function-to-community membership
-- ============================================================================

CREATE TABLE public.communities (
  content_hash TEXT NOT NULL,
  level INTEGER NOT NULL,
  community_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  PRIMARY KEY (content_hash, level, algorithm, repo_id)
);

CREATE INDEX idx_communities_repo ON public.communities (repo_id);
CREATE INDEX idx_communities_community ON public.communities (community_id, repo_id);
CREATE INDEX idx_communities_hash ON public.communities (content_hash, repo_id);

ALTER TABLE public.communities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "comm_select_own" ON public.communities
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "comm_insert_own" ON public.communities
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "comm_delete_own" ON public.communities
  FOR DELETE USING (user_id = auth.uid());

COMMIT;

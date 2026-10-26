-- Migration 00004: Community edges table
--
-- Stores aggregated inter-community connections derived from
-- function-level edges. Full-replaced on each sync (like communities).
--
-- See docs/architecture/auto-docs.md for design rationale.

BEGIN;

CREATE TABLE public.community_edges (
  source_community TEXT NOT NULL,
  target_community TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_community, target_community, algorithm, repo_id)
);

CREATE INDEX idx_ce_repo ON public.community_edges (repo_id);
CREATE INDEX idx_ce_source_repo ON public.community_edges (source_community, repo_id);
CREATE INDEX idx_ce_target_repo ON public.community_edges (target_community, repo_id);

ALTER TABLE public.community_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ce_select_own" ON public.community_edges
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "ce_insert_own" ON public.community_edges
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "ce_delete_own" ON public.community_edges
  FOR DELETE USING (user_id = auth.uid());

COMMIT;

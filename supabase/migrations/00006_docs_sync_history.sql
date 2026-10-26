-- Migration 00006: Docs sync history
--
-- Tracks which git commits were synced for architecture documentation.
-- Each sync records commit hash, branch, and timestamp.
-- repos table gets quick-access fields for the latest sync.

BEGIN;

-- ============================================================================
-- 1. DOCS_SYNC_HISTORY -- Per-sync commit tracking
-- ============================================================================

CREATE TABLE public.docs_sync_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  branch TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dsh_repo ON public.docs_sync_history (repo_id, synced_at DESC);

ALTER TABLE public.docs_sync_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dsh_select_own" ON public.docs_sync_history
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "dsh_insert_own" ON public.docs_sync_history
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- 2. REPOS -- Quick-access fields for latest docs sync
-- ============================================================================

ALTER TABLE public.repos ADD COLUMN last_docs_sync_commit TEXT;
ALTER TABLE public.repos ADD COLUMN last_docs_sync_at TIMESTAMPTZ;

COMMIT;

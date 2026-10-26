-- Dismissed security issues (per-user, per-repo)
-- Separate from immutable content-addressed function_analysis.
-- Supports personal dismissals now; team-wide dismissals later via team_id column.

CREATE TABLE public.dismissed_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  issue_index INTEGER NOT NULL,
  flag TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('false_positive', 'accepted_risk', 'wont_fix')),
  note TEXT,
  dismissed_by UUID NOT NULL REFERENCES auth.users(id),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, content_hash, issue_index, dismissed_by)
);

-- Index for efficient filtering when loading dashboard stats
CREATE INDEX idx_dismissed_issues_repo ON public.dismissed_issues(repo_id);
CREATE INDEX idx_dismissed_issues_hash ON public.dismissed_issues(repo_id, content_hash);

-- RLS: users can manage their own dismissals
ALTER TABLE public.dismissed_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dismissals"
  ON public.dismissed_issues FOR SELECT
  USING (dismissed_by = auth.uid());

CREATE POLICY "Users can insert own dismissals"
  ON public.dismissed_issues FOR INSERT
  WITH CHECK (dismissed_by = auth.uid());

CREATE POLICY "Users can delete own dismissals"
  ON public.dismissed_issues FOR DELETE
  USING (dismissed_by = auth.uid());

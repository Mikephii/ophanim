-- Add docs_branch to repos table.
-- Architecture data (communities, summaries, edges) is only synced to Supabase
-- when the CLI is running on this branch. Non-git repos bypass the gate entirely.
ALTER TABLE public.repos ADD COLUMN docs_branch TEXT NOT NULL DEFAULT 'main';

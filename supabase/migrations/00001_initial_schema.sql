-- Ophan initial schema
-- Sets up: users, teams, repos, function_analysis, function_locations, function_gc
-- Plus: RLS policies, trigger functions, indexes

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- Auto-create public.users row when a new auth user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-update updated_at timestamp on row modification
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TABLES
-- ============================================================================

-- 1. Users (extends auth.users)
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 2. Teams (structure for shared team access)
CREATE TABLE public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 3. Team members (junction table)
CREATE TABLE public.team_members (
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'admin', 'member'
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- 4. Repos (one user can have many repos, optionally shared with a team)
CREATE TABLE public.repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  remote_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.repos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5. Function analysis (synced from client SQLite, content-addressed)
CREATE TABLE public.function_analysis (
  content_hash TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  analysis JSONB NOT NULL,
  model_version TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  -- Generated columns for efficient security querying
  security_flag_count INTEGER GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb))
  ) STORED,
  has_security_flags BOOLEAN GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb)) > 0
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, repo_id)
);

-- 6. Function locations (file→hash mappings, full-replaced on each sync)
CREATE TABLE public.function_locations (
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  function_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  PRIMARY KEY (repo_id, file_path, function_name)
);

-- 7. Function GC (processing queue for garbage collection sync)
--    Rows are deleted after sync applies the deletions to function_analysis/locations
CREATE TABLE public.function_gc (
  content_hash TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES public.repos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  gc_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, repo_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Security querying: GIN indexes for JSONB containment operators (?, ?|, ?&)
CREATE INDEX idx_fa_security_flags ON public.function_analysis
  USING GIN ((analysis->'securityFlags'));
CREATE INDEX idx_fa_data_tags ON public.function_analysis
  USING GIN ((analysis->'dataTags'));

-- Security querying: sort by flag count (partial index, only flagged rows)
CREATE INDEX idx_fa_security_count ON public.function_analysis
  (repo_id, security_flag_count DESC)
  WHERE has_security_flags = true;

-- Repo-scoped lookups
CREATE INDEX idx_fa_repo ON public.function_analysis (repo_id);
CREATE INDEX idx_fl_repo ON public.function_locations (repo_id);
CREATE INDEX idx_fl_hash ON public.function_locations (content_hash, repo_id);
CREATE INDEX idx_repos_user ON public.repos (user_id);

-- Team lookups (future)
CREATE INDEX idx_repos_team ON public.repos (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_team_members_user ON public.team_members (user_id);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.function_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.function_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.function_gc ENABLE ROW LEVEL SECURITY;

-- Users: read/update own row
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE USING (id = auth.uid());

-- Teams: members can read their teams
CREATE POLICY "teams_select_member" ON public.teams
  FOR SELECT USING (
    id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
  );

-- Team members: can read memberships for own teams
CREATE POLICY "team_members_select_own" ON public.team_members
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "team_members_select_team" ON public.team_members
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
  );

-- Repos: CRUD own repos
CREATE POLICY "repos_select_own" ON public.repos
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "repos_insert_own" ON public.repos
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "repos_update_own" ON public.repos
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "repos_delete_own" ON public.repos
  FOR DELETE USING (user_id = auth.uid());

-- Function analysis: read/insert/update/delete own data
CREATE POLICY "fa_select_own" ON public.function_analysis
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "fa_insert_own" ON public.function_analysis
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "fa_update_own" ON public.function_analysis
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "fa_delete_own" ON public.function_analysis
  FOR DELETE USING (user_id = auth.uid());

-- Function locations: read/insert/delete own data
CREATE POLICY "fl_select_own" ON public.function_locations
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "fl_insert_own" ON public.function_locations
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "fl_delete_own" ON public.function_locations
  FOR DELETE USING (user_id = auth.uid());

-- Function GC: read/insert/delete own data
CREATE POLICY "gc_select_own" ON public.function_gc
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "gc_insert_own" ON public.function_gc
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "gc_delete_own" ON public.function_gc
  FOR DELETE USING (user_id = auth.uid());

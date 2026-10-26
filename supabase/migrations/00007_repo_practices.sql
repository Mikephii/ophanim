-- Repo-scoped coding practices (managed via webapp, synced to local SQLite by CLI)
CREATE TABLE repo_practices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  practice_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (repo_id, practice_id)
);

ALTER TABLE repo_practices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage practices for their repos"
  ON repo_practices FOR ALL
  USING (repo_id IN (SELECT id FROM repos WHERE user_id = auth.uid()))
  WITH CHECK (repo_id IN (SELECT id FROM repos WHERE user_id = auth.uid()));

CREATE TRIGGER update_repo_practices_updated_at
  BEFORE UPDATE ON repo_practices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

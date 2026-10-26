-- Migration 00008: Add start_line to function_locations
-- Enables webapp to display file-absolute line numbers for security issues.
-- start_line is the 1-indexed line number where the function starts in its file.
-- DEFAULT 0 means "unknown" (old synced data degrades gracefully to function-relative lines).

ALTER TABLE public.function_locations
  ADD COLUMN start_line INTEGER NOT NULL DEFAULT 0;

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  source_url TEXT,
  status TEXT DEFAULT 'queued',
  summary TEXT,
  total_pages INT DEFAULT 0,
  processed_pages INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL,
  dismissed_from_queue BOOLEAN DEFAULT FALSE,
  name_embedding vector(3072)
);

CREATE TABLE IF NOT EXISTS pdf_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  summary TEXT,
  notes TEXT,
  schema_json JSONB NOT NULL,
  summary_embedding vector(3072),
  page_number INT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pdf_table_id UUID REFERENCES pdf_tables(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  text_summary TEXT,
  summary_embedding vector(3072),
  page_number INT,
  chunk_index INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  archived_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS context_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES context_spaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  original_uri TEXT,
  canonical_uri TEXT,
  status TEXT DEFAULT 'queued',
  summary TEXT,
  metadata_json JSONB DEFAULT '{}'::jsonb,
  source_embedding vector(3072),
  source_group_key TEXT,
  version_no INT DEFAULT 1,
  is_latest BOOLEAN DEFAULT TRUE,
  content_hash TEXT,
  legacy_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS context_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES context_sources(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  asset_uri TEXT,
  mime_type TEXT,
  byte_size BIGINT,
  metadata_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES context_sources(id) ON DELETE CASCADE,
  segment_type TEXT NOT NULL,
  segment_index INT DEFAULT 0,
  page_number INT,
  locator_json JSONB,
  text_content TEXT NOT NULL,
  structured_json JSONB,
  embedding vector(3072),
  token_count INT,
  legacy_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_scope_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  selected_space_ids JSONB DEFAULT '[]'::jsonb,
  selected_source_types JSONB DEFAULT '["pdf","bookmark","snip"]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dev_page_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  title TEXT,
  source TEXT DEFAULT 'extension',
  payload_json JSONB NOT NULL,
  hierarchy_text TEXT,
  plain_text TEXT,
  node_count INT DEFAULT 0,
  link_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Migrations for existing databases
DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pdf_tables ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN summary TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN dismissed_from_queue BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN name_embedding vector(3072);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN source_embedding vector(3072);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN source_group_key TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN version_no INT DEFAULT 1;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN is_latest BOOLEAN DEFAULT TRUE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN content_hash TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_sources ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE context_segments ADD COLUMN legacy_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE chat_scope_selections ADD COLUMN selected_source_types JSONB DEFAULT '["pdf","bookmark","snip"]'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

INSERT INTO context_spaces (name, description, is_default)
SELECT 'General Context Space', 'Auto-created default context space', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM context_spaces WHERE is_default = TRUE
);

INSERT INTO context_sources (
  space_id,
  source_type,
  title,
  original_uri,
  canonical_uri,
  status,
  summary,
  metadata_json,
  source_embedding,
  source_group_key,
  version_no,
  is_latest,
  content_hash,
  legacy_document_id,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  cs.id,
  'pdf',
  d.filename,
  d.source_url,
  d.source_url,
  CASE
    WHEN d.deleted_at IS NOT NULL THEN 'archived'
    ELSE COALESCE(d.status, 'completed')
  END,
  d.summary,
  '{}'::jsonb,
  d.name_embedding,
  d.id::text,
  1,
  TRUE,
  NULL,
  d.id,
  d.created_at,
  COALESCE(d.updated_at, d.created_at),
  d.deleted_at
FROM documents d
JOIN context_spaces cs ON cs.is_default = TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM context_sources s WHERE s.legacy_document_id = d.id
);

INSERT INTO context_segments (
  source_id,
  segment_type,
  segment_index,
  page_number,
  locator_json,
  text_content,
  structured_json,
  embedding,
  token_count,
  legacy_chunk_id,
  created_at
)
SELECT
  s.id,
  'table_row',
  COALESCE(c.chunk_index, 0),
  c.page_number,
  jsonb_build_object('pdf_table_id', c.pdf_table_id),
  COALESCE(c.text_summary, ''),
  c.data,
  c.summary_embedding,
  NULL,
  c.id,
  c.created_at
FROM chunks c
JOIN context_sources s ON s.legacy_document_id = c.document_id
WHERE NOT EXISTS (
  SELECT 1 FROM context_segments cs
  WHERE cs.legacy_chunk_id = c.id
);

UPDATE context_sources
SET version_no = 1
WHERE version_no IS NULL;

UPDATE context_sources
SET is_latest = TRUE
WHERE is_latest IS NULL;

UPDATE context_sources
SET source_group_key = id::text
WHERE source_group_key IS NULL;

WITH bookmark_groups AS (
  SELECT
    id,
    MIN(id::text) OVER (
      PARTITION BY space_id, COALESCE(canonical_uri, id::text)
    ) AS grp
  FROM context_sources
  WHERE source_type = 'bookmark'
)
UPDATE context_sources src
SET source_group_key = bg.grp
FROM bookmark_groups bg
WHERE src.id = bg.id
  AND (src.source_group_key IS NULL OR src.source_group_key = src.id::text);

WITH ranked_bookmarks AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY space_id, COALESCE(canonical_uri, id::text)
      ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC
    ) AS rn
  FROM context_sources
  WHERE source_type = 'bookmark'
)
UPDATE context_sources src
SET is_latest = CASE WHEN rb.rn = 1 THEN TRUE ELSE FALSE END
FROM ranked_bookmarks rb
WHERE src.id = rb.id;

-- Create indexes after migrations so referenced columns are guaranteed to exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_scope_key_unique ON chat_scope_selections(scope_key);
CREATE INDEX IF NOT EXISTS idx_context_sources_space_type_status_created ON context_sources(space_id, source_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_sources_space_type_latest_updated ON context_sources(space_id, source_type, is_latest, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_sources_space_canonical_latest ON context_sources(space_id, canonical_uri, is_latest);
CREATE INDEX IF NOT EXISTS idx_context_sources_group_version ON context_sources(space_id, source_group_key, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_context_segments_source_segment_page ON context_segments(source_id, segment_index, page_number);
CREATE INDEX IF NOT EXISTS idx_dev_page_extractions_created_at ON dev_page_extractions(created_at DESC);

-- Drop legacy tables if they exist (they were never used)
DROP TABLE IF EXISTS semantic_chunks CASCADE;
DROP TABLE IF EXISTS schema_registry CASCADE;
`;

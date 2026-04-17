-- Lucius D1 Database Schema
-- Migration: 0001_initial
-- Description: Initial schema for applications, projects, and project_applications

-- --- Applications Table ---
-- Mirrors the existing 68-column Illuminance Selector database.
-- Populated via scripts/seed-applications.js (import from CSV/JSON export).
-- Do NOT alter column names - they map directly to the legacy data format.

CREATE TABLE IF NOT EXISTS applications (
  -- Identity & Hierarchy
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT UNIQUE NOT NULL, -- e.g. "RP-9_A-1_45" (used as Vectorize ID)
  App                   TEXT,                 -- Top-level category (e.g. "Healthcare")
  App_s1                TEXT,                 -- Sub-category 1 (e.g. "Hospitals and Ambulatory Care")
  App_s2                TEXT,                 -- Sub-category 2 (e.g. "Spas")
  App_s3                TEXT,
  App_s4                TEXT,
  App_s5                TEXT,
  App_s6                TEXT,

  -- Standard Reference
  Standard              TEXT,                 -- e.g. "RP-9-20"
  Standard_Full         TEXT,                 -- e.g. "ANSI/IES RP-9-20"
  Table_Ref             TEXT,                 -- e.g. "Table A-1"
  Row_Ref               TEXT,                 -- e.g. "Row 45"
  Link_Mapping          TEXT,                 -- Section ID for Vitrium deep link

  -- Application Type
  Area_or_Task          TEXT,                 -- "Area" | "Task"
  Indoor_Outdoor        TEXT,                 -- "Indoor" | "Outdoor" | "Both"
  App_Type              TEXT,                 -- Additional classification

  -- Horizontal Illuminance
  Hor_Cat               TEXT,                 -- Illuminance category (A-P)
  Hor_Lux               REAL,                 -- Maintained illuminance (lux)
  Hor_Fc                REAL,                 -- Maintained illuminance (footcandles)
  Hor_Height_m          REAL,                 -- Measurement height (meters)
  Hor_Height_ft         REAL,                 -- Measurement height (feet)
  Hor_Avg_Max_Min       TEXT,                 -- "Average" | "Max" | "Min"
  Hor_Uniformity        TEXT,                 -- e.g. "4:1 (Avg:Min)"
  Hor_Notes             TEXT,

  -- Vertical Illuminance
  Ver_Cat               TEXT,
  Ver_Lux               REAL,
  Ver_Fc                REAL,
  Ver_Height_m          REAL,
  Ver_Height_ft         REAL,
  Ver_Avg_Max_Min       TEXT,
  Ver_Uniformity        TEXT,
  Ver_Notes             TEXT,

  -- Task Illuminance (where applicable)
  Task_Cat              TEXT,
  Task_Lux              REAL,
  Task_Fc               REAL,
  Task_Height_m         REAL,
  Task_Height_ft        REAL,
  Task_Avg_Max_Min      TEXT,
  Task_Uniformity       TEXT,
  Task_Notes            TEXT,

  -- TM-24 Spectral Adjustment
  TM24_Eligible         INTEGER DEFAULT 0,   -- 0 = No, 1 = Yes
  TM24_Notes            TEXT,

  -- Outdoor Lighting Controls (for outdoor applications)
  Lighting_Zone         TEXT,                 -- "LZ0" - "LZ4"
  Max_Glare_Rating      TEXT,                 -- BUG system (e.g. "G2")
  Max_Uplight           TEXT,                 -- BUG system (e.g. "U1")
  Curfew_Dimming        TEXT,                 -- e.g. "50% after 11 PM"
  Spectrum_Guidance     TEXT,                 -- e.g. "CCT <= 3000K"
  Controls_Required     TEXT,

  -- Footnotes & Notes
  Footnotes             TEXT,                 -- Comma-separated footnote numbers
  General_Notes         TEXT,                 -- Annex A references
  App_Notes             TEXT,                 -- Application-specific notes

  -- Vitrium Integration
  Vitrium_Doc_ID        TEXT,                 -- Document ID in Vitrium DRM system
  Vitrium_Deep_Link     TEXT,                 -- Full deep link URL

  -- Status
  Active                INTEGER DEFAULT 1,    -- 0 = deprecated standard
  Deprecated_By         TEXT,                 -- Code of superseding application

  -- Timestamps
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_applications_standard ON applications(Standard);
CREATE INDEX IF NOT EXISTS idx_applications_app ON applications(App);
CREATE INDEX IF NOT EXISTS idx_applications_indoor_outdoor ON applications(Indoor_Outdoor);
CREATE INDEX IF NOT EXISTS idx_applications_active ON applications(Active);
CREATE INDEX IF NOT EXISTS idx_applications_code ON applications(code);

-- --- Standards Table ---
-- Metadata for each IES standard document.
-- Populated during PDF ingestion (scripts/ingest-pdfs.js).

CREATE TABLE IF NOT EXISTS standards (
  id                TEXT PRIMARY KEY,         -- e.g. "RP-9-20" or "ANSI/IES RP-9-20"
  title             TEXT NOT NULL,
  full_designation  TEXT,                     -- e.g. "ANSI/IES RP-9-20"
  description       TEXT,
  author            TEXT,
  year              INTEGER,
  edition           TEXT,
  status            TEXT DEFAULT 'Active',    -- 'Active' | 'Deprecated'
  supersedes        TEXT,                     -- ID of previous edition
  superseded_by     TEXT,                     -- ID of newer edition
  r2_key            TEXT,                     -- R2 object key (e.g. "standards/RP-9-20.pdf")
  vitrium_doc_id    TEXT,
  pages_json        TEXT,                     -- JSON: [{number, text, height, width}]
  tables_json       TEXT,                     -- JSON: [{pageNumber, header, rows, footnotes}]
  indexed_at        TIMESTAMP,               -- When last ingested into Vectorize
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_standards_status ON standards(status);
CREATE INDEX IF NOT EXISTS idx_standards_year ON standards(year);

-- --- Projects Table ---
-- User-created project containers for collecting lighting applications.

CREATE TABLE IF NOT EXISTS projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,         -- References Wicket member ID (Phase 3)
  name              TEXT NOT NULL,
  location          TEXT,
  client_name       TEXT,
  client_company    TEXT,
  project_type      TEXT CHECK(project_type IN (
                      'New Construction', 'Renovation', 'Addition', 'Retrofit', NULL
                    )),
  designer_name     TEXT,
  designer_company  TEXT,
  target_codes      TEXT,                     -- Comma-separated: "IECC, ASHRAE, Title 24"
  status            TEXT DEFAULT 'Active' CHECK(status IN ('Active', 'Archived')),
  notes             TEXT,
  share_token       TEXT UNIQUE,              -- For read-only share links (Phase 1)
  share_expires_at  TIMESTAMP,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  modified_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_share_token ON projects(share_token);

-- --- Project Applications Table ---
-- Junction table: which applications belong to which project, with customizations.

CREATE TABLE IF NOT EXISTS project_applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  application_code  TEXT NOT NULL,            -- References applications.code
  snapshot_data     TEXT,                     -- JSON: full 68-col snapshot at time of save
  quantity          INTEGER DEFAULT 1,        -- Number of this space type in project
  room_names        TEXT,                     -- Newline-separated room names/numbers
  custom_notes      TEXT,
  -- Override fields (advanced: user deviates from IES standard)
  overridden        INTEGER DEFAULT 0,        -- 0 = No, 1 = Yes
  override_hor_lux  REAL,
  override_ver_lux  REAL,
  override_reason   TEXT,
  sort_order        INTEGER DEFAULT 0,        -- For manual reordering
  added_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_apps_project_id ON project_applications(project_id);
CREATE INDEX IF NOT EXISTS idx_project_apps_code ON project_applications(application_code);

-- --- Triggers: auto-update modified_at on projects ---

CREATE TRIGGER IF NOT EXISTS trg_projects_modified
  AFTER UPDATE ON projects
  FOR EACH ROW
BEGIN
  UPDATE projects SET modified_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_app_modified
  AFTER INSERT ON project_applications
  FOR EACH ROW
BEGIN
  UPDATE projects SET modified_at = CURRENT_TIMESTAMP WHERE id = NEW.project_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_app_delete_modified
  AFTER DELETE ON project_applications
  FOR EACH ROW
BEGIN
  UPDATE projects SET modified_at = CURRENT_TIMESTAMP WHERE id = OLD.project_id;
END;

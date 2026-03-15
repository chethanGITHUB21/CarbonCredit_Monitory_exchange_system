-- =============================================================================
--  CARBON CREDIT MONITORING AND EXCHANGE SYSTEM
--  Schema Migration — v2.0
--  Run AFTER the base schema.sql (which creates users, buyer_profiles,
--  emission_records, seller_projects, carbon_transactions, and views).
--
--  This file adds the NEW tables required by the architecture documentation
--  without touching or breaking the existing tables the UI depends on.
--
--  Standards: IPCC 2006 + 2019 Refinement | GWP-100 AR5
-- =============================================================================

-- Require PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── TABLE: auth_sessions ─────────────────────────────────────────────────────
-- Tracks login/logout for audit trail.
-- POST /api/auth/login  → INSERT  |  POST /api/auth/logout → UPDATE logout_time
CREATE TABLE IF NOT EXISTS auth_sessions (
    id          SERIAL       PRIMARY KEY,
    user_id     UUID         REFERENCES users(id) ON DELETE CASCADE,
    jwt_token   TEXT         NOT NULL,
    login_time  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    logout_time TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user  ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(jwt_token);

-- ── TABLE: countries ─────────────────────────────────────────────────────────
-- Reference table for GIS regional filter cascade.
CREATE TABLE IF NOT EXISTS countries (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

-- ── TABLE: states ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS states (
    id         SERIAL PRIMARY KEY,
    country_id INT REFERENCES countries(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_states_country ON states(country_id);

-- ── TABLE: districts ─────────────────────────────────────────────────────────
-- Stores admin boundaries as MultiPolygon geometries.
-- MANUAL STEP: Load shapefile into this table using ogr2ogr or QGIS.
-- boundary column uses PostGIS geometry type.
CREATE TABLE IF NOT EXISTS districts (
    id        SERIAL PRIMARY KEY,
    state_id  INT REFERENCES states(id) ON DELETE CASCADE,
    name      VARCHAR(100) NOT NULL,
    boundary  GEOMETRY(MultiPolygon, 4326)
);
CREATE INDEX IF NOT EXISTS idx_districts_state ON districts(state_id);
-- PostGIS spatial index for boundary queries
CREATE INDEX IF NOT EXISTS idx_districts_geom
    ON districts USING GIST (boundary);

-- ── TABLE: projects ──────────────────────────────────────────────────────────
-- Stores both emission and absorption projects with spatial location.
-- location is a POINT geometry (longitude, latitude, SRID 4326).
-- MANUAL STEP: Spatial index is created below; populate via /api/projects POST.
CREATE TABLE IF NOT EXISTS projects (
    id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID         REFERENCES users(id) ON DELETE CASCADE,
    project_name VARCHAR(200) NOT NULL,
    project_type VARCHAR(50),          -- 'emission' | 'absorption' | 'reforestation' etc.
    description  TEXT,
    country_id   INT          REFERENCES countries(id),
    state_id     INT          REFERENCES states(id),
    district_id  INT          REFERENCES districts(id),
    location     GEOMETRY(Point, 4326),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
-- PostGIS spatial index for project location queries
CREATE INDEX IF NOT EXISTS idx_projects_location
    ON projects USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_projects_user
    ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_type
    ON projects(project_type);

-- ── TABLE: emissions ─────────────────────────────────────────────────────────
-- Simple per-project emission records (doc schema).
-- Linked to projects table via project_id.
-- More detailed IPCC breakdown is in emission_records (existing table).
CREATE TABLE IF NOT EXISTS emissions (
    id          SERIAL       PRIMARY KEY,
    project_id  UUID         REFERENCES projects(id) ON DELETE CASCADE,
    co2_amount  NUMERIC(12,2),
    unit        VARCHAR(20)  DEFAULT 'tonnes',
    year        INT,
    recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_emissions_project ON emissions(project_id);
CREATE INDEX IF NOT EXISTS idx_emissions_year    ON emissions(year);

-- ── TABLE: absorptions ───────────────────────────────────────────────────────
-- Per-project absorption records.
-- area_hectares enables IPCC AFOLU absorption rate calculations.
CREATE TABLE IF NOT EXISTS absorptions (
    id           SERIAL       PRIMARY KEY,
    project_id   UUID         REFERENCES projects(id) ON DELETE CASCADE,
    co2_absorbed NUMERIC(12,2),
    area_hectares NUMERIC(10,2),
    year         INT,
    recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_absorptions_project ON absorptions(project_id);
CREATE INDEX IF NOT EXISTS idx_absorptions_year    ON absorptions(year);

-- ── TABLE: carbon_credits ────────────────────────────────────────────────────
-- Tracks total and available credits per project.
-- 1 credit = 1 tCO2e reduction/removal (IPCC standard).
CREATE TABLE IF NOT EXISTS carbon_credits (
    id               SERIAL       PRIMARY KEY,
    project_id       UUID         REFERENCES projects(id),
    total_credits    NUMERIC(12,2),
    available_credits NUMERIC(12,2),
    price_per_credit NUMERIC(10,2),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_carbon_credits_project ON carbon_credits(project_id);

-- ── TABLE: credit_listings ───────────────────────────────────────────────────
-- Marketplace listings created by sellers.
-- GET /api/credits/listing  |  POST /api/credits
CREATE TABLE IF NOT EXISTS credit_listings (
    id               SERIAL       PRIMARY KEY,
    credit_id        INT          REFERENCES carbon_credits(id),
    seller_id        UUID         REFERENCES users(id),
    credits_for_sale NUMERIC(12,2),
    price_per_credit NUMERIC(10,2),
    status           VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active | sold | cancelled
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON credit_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON credit_listings(status);

-- ── TABLE: credit_transactions ───────────────────────────────────────────────
-- Records each credit purchase.
-- POST /api/credits/purchase  |  GET /api/credits/transaction
CREATE TABLE IF NOT EXISTS credit_transactions (
    id               SERIAL       PRIMARY KEY,
    listing_id       INT          REFERENCES credit_listings(id),
    buyer_id         UUID         REFERENCES users(id),
    credits_bought   NUMERIC(12,2),
    total_price      NUMERIC(12,2),
    transaction_time TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_txn_buyer   ON credit_transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_credit_txn_listing ON credit_transactions(listing_id);

-- ── FIX: vw_yearly_trend (BUG-04 — Cartesian product) ───────────────────────
-- Original view joined emission_records × carbon_transactions without proper
-- ON clause, inflating credits_traded by N×. Replaced with independent subqueries.
CREATE OR REPLACE VIEW vw_yearly_trend AS
WITH yearly_emissions AS (
    SELECT er.year,
           SUM(er.total_co2e)        AS total_emission_co2e,
           SUM(er.total_absorption)  AS total_absorption_co2e,
           SUM(er.net_balance)       AS net_balance
    FROM   emission_records er
    JOIN   buyer_profiles bp ON bp.id = er.buyer_id
    GROUP  BY er.year
),
yearly_credits AS (
    SELECT EXTRACT(YEAR FROM trade_date)::smallint AS year,
           SUM(credits_traded)                     AS credits_traded
    FROM   carbon_transactions
    GROUP  BY EXTRACT(YEAR FROM trade_date)
)
SELECT ye.year,
       ye.total_emission_co2e,
       ye.total_absorption_co2e,
       ye.net_balance,
       COALESCE(yc.credits_traded, 0) AS credits_traded
FROM   yearly_emissions ye
LEFT   JOIN yearly_credits yc ON yc.year = ye.year
ORDER  BY ye.year;

-- vw_regional_emission is unchanged (no Cartesian bug — kept as-is)

-- =============================================================================
-- MANUAL STEPS (Do NOT run via this script)
-- =============================================================================
-- 1. Load India district shapefiles into `districts` table:
--    ogr2ogr -f "PostgreSQL" PG:"dbname=carbon_db user=postgres" \
--      india_districts.shp -nln districts -nlt MULTIPOLYGON -t_srs EPSG:4326 \
--      -lco GEOMETRY_NAME=boundary
--
-- 2. Populate countries + states reference tables:
--    INSERT INTO countries (name) VALUES ('India');
--    INSERT INTO states (country_id, name) VALUES (1,'Tamil Nadu'), (1,'Karnataka'), ...;
--
-- 3. Configure GeoServer workspace "carbon_ledger":
--    - Store: PostGIS → carbon_db
--    - Layers: districts (WMS), projects (WFS/WMS), emission_points (WMS)
--    - Frontend loads tiles at: http://localhost:8080/geoserver/carbon_ledger/wms
--    - Frontend loads WFS at:   http://localhost:8080/geoserver/carbon_ledger/wfs
--
-- 4. Apply spatial styling in GeoServer (SLD files):
--    - districts layer: choropleth by emission intensity
--    - emission layer:  circle size proportional to total_co2e
--    - absorption layer: green points for sinks
-- =============================================================================

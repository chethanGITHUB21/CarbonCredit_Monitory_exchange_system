// routes/gis.js — GIS Spatial Service
// NOTE: GeoServer streams map TILES directly to the frontend (OpenLayers).
//       These endpoints serve metadata / feature JSON for popups and filters.
//       They do NOT proxy raster tiles.
//
// GET /api/gis/projects      → project locations as GeoJSON FeatureCollection
// GET /api/gis/districts     → districts as GeoJSON FeatureCollection (boundaries)
// GET /api/gis/emission-map  → emission point data for map layer
// GET /api/gis/projects-map  → all projects with coordinates for map rendering
// GET /api/gis/absorption-map → absorption project locations for map layer

const router = require('express').Router();
const pool   = require('../config/db');
const auth   = require('../middleware/auth');

// ── Shared filter builder (country / state / district) ──────────────────────
function buildRegionFilter(query, startIdx = 1) {
  const { country, state, district } = query;
  const filters = [];
  const values  = [];
  let   idx     = startIdx;

  if (country && String(country).trim()) {
    values.push(String(country).trim());
    filters.push(`LOWER(TRIM(u.country)) = LOWER(TRIM($${idx++}))`);
  }
  if (state && String(state).trim()) {
    values.push(String(state).trim());
    filters.push(`LOWER(TRIM(u.state)) = LOWER(TRIM($${idx++}))`);
  }
  if (district && String(district).trim()) {
    values.push(String(district).trim());
    filters.push(`LOWER(TRIM(u.district)) = LOWER(TRIM($${idx++}))`);
  }

  return {
    where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    values,
    nextIdx: idx,
  };
}

// ── GET /api/gis/projects ────────────────────────────────────────────────────
// All projects with Point geometry as GeoJSON (for OpenLayers vector layer)
router.get('/projects', auth, async (req, res) => {
  try {
    // Try projects table with PostGIS location column
    const result = await pool.query(
      `SELECT p.id, p.project_name, p.project_type, p.description,
              u.organisation_name, u.country, u.state, u.district,
              ST_AsGeoJSON(p.location)::json AS geometry,
              ST_X(p.location)               AS longitude,
              ST_Y(p.location)               AS latitude
       FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE p.location IS NOT NULL
       ORDER BY p.created_at DESC
       LIMIT 500`
    );

    const featureCollection = {
      type: 'FeatureCollection',
      features: result.rows.map(r => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
          id:                r.id,
          project_name:      r.project_name,
          project_type:      r.project_type,
          description:       r.description,
          organisation_name: r.organisation_name,
          country:           r.country,
          state:             r.state,
          district:          r.district,
          longitude:         r.longitude,
          latitude:          r.latitude,
        },
      })),
    };
    return res.json(featureCollection);
  } catch (err) {
    // Fallback: projects table may not have PostGIS or may not exist yet
    console.error('gis/projects error:', err.message);
    return res.json({ type: 'FeatureCollection', features: [], error: err.message });
  }
});

// ── GET /api/gis/districts ───────────────────────────────────────────────────
// District boundaries as GeoJSON — sourced from PostGIS districts table.
// If districts table not yet populated returns empty collection.
router.get('/districts', auth, async (req, res) => {
  const { state_id, country_id } = req.query;
  try {
    const params  = [];
    let   where   = '';
    if (state_id) {
      params.push(parseInt(state_id));
      where = `WHERE d.state_id = $${params.length}`;
    } else if (country_id) {
      params.push(parseInt(country_id));
      where = `WHERE s.country_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT d.id, d.name,
              s.name  AS state_name,
              c.name  AS country_name,
              ST_AsGeoJSON(d.boundary)::json AS geometry
       FROM   districts d
       JOIN   states    s ON s.id = d.state_id
       JOIN   countries c ON c.id = s.country_id
       ${where}
       ORDER  BY d.name
       LIMIT  500`,
      params
    );

    const featureCollection = {
      type: 'FeatureCollection',
      features: result.rows.map(r => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
          id:           r.id,
          name:         r.name,
          state_name:   r.state_name,
          country_name: r.country_name,
        },
      })),
    };
    return res.json(featureCollection);
  } catch (err) {
    console.error('gis/districts error:', err.message);
    return res.json({ type: 'FeatureCollection', features: [], error: err.message });
  }
});

// ── GET /api/gis/emission-map ────────────────────────────────────────────────
// Emission data per project location for choropleth / heat layer.
// Supports same country/state/district filter as dashboard.
router.get('/emission-map', auth, async (req, res) => {
  try {
    const { where, values } = buildRegionFilter(req.query);

    // Join projects → emissions → users for regional filter
    // Try new emissions table; fall back to emission_records
    let rows = [];
    try {
      rows = (await pool.query(
        `SELECT p.id AS project_id, p.project_name,
                u.country, u.state, u.district,
                ST_AsGeoJSON(p.location)::json AS geometry,
                SUM(e.co2_amount)              AS total_co2,
                MAX(e.year)                    AS latest_year
         FROM   emissions e
         JOIN   projects  p ON p.id = e.project_id
         JOIN   users     u ON u.id = p.user_id
         ${where.replace(/u\.country/g, 'u.country')}
         GROUP  BY p.id, p.project_name, u.country, u.state, u.district, p.location
         ORDER  BY total_co2 DESC
         LIMIT  300`,
        values
      )).rows;
    } catch {
      // emissions table not yet created — fall back to emission_records
      rows = (await pool.query(
        `SELECT p.id AS project_id, p.project_name,
                u.country, u.state, u.district,
                ST_AsGeoJSON(p.location)::json AS geometry,
                SUM(er.total_co2e)             AS total_co2,
                MAX(er.year)                   AS latest_year
         FROM   emission_records er
         JOIN   buyer_profiles   bp ON bp.id = er.buyer_id
         JOIN   users            u  ON u.id  = bp.user_id
         LEFT   JOIN projects    p  ON p.user_id = u.id
         ${where}
         GROUP  BY p.id, p.project_name, u.country, u.state, u.district, p.location
         ORDER  BY total_co2 DESC
         LIMIT  300`,
        values
      ).catch(() => ({ rows: [] }))).rows;
    }

    const featureCollection = {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
          project_id:   r.project_id,
          project_name: r.project_name,
          country:      r.country,
          state:        r.state,
          district:     r.district,
          total_co2:    Number(r.total_co2) || 0,
          latest_year:  r.latest_year,
          unit:         't CO₂e',
        },
      })),
    };
    return res.json(featureCollection);
  } catch (err) {
    console.error('gis/emission-map error:', err.message);
    return res.json({ type: 'FeatureCollection', features: [], error: err.message });
  }
});

// ── GET /api/gis/projects-map ────────────────────────────────────────────────
// All projects (emission + absorption) with type labelling for map icons.
router.get('/projects-map', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.project_name, p.project_type, p.description,
              u.organisation_name, u.country, u.state, u.district,
              ST_AsGeoJSON(p.location)::json AS geometry
       FROM projects p
       JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
       LIMIT 500`
    );

    const featureCollection = {
      type: 'FeatureCollection',
      features: result.rows.map(r => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
          id:                r.id,
          project_name:      r.project_name,
          project_type:      r.project_type,
          description:       r.description,
          organisation_name: r.organisation_name,
          country:           r.country,
          state:             r.state,
          district:          r.district,
        },
      })),
    };
    return res.json(featureCollection);
  } catch (err) {
    console.error('gis/projects-map error:', err.message);
    return res.json({ type: 'FeatureCollection', features: [], error: err.message });
  }
});

// ── GET /api/gis/absorption-map ──────────────────────────────────────────────
// Absorption data per project for map layer (green sinks).
router.get('/absorption-map', auth, async (req, res) => {
  try {
    const { where, values } = buildRegionFilter(req.query);

    let rows = [];
    try {
      rows = (await pool.query(
        `SELECT p.id AS project_id, p.project_name, p.project_type,
                u.country, u.state, u.district,
                ST_AsGeoJSON(p.location)::json AS geometry,
                SUM(a.co2_absorbed)            AS total_absorbed,
                SUM(a.area_hectares)           AS total_hectares,
                MAX(a.year)                    AS latest_year
         FROM   absorptions a
         JOIN   projects    p ON p.id = a.project_id
         JOIN   users       u ON u.id = p.user_id
         ${where}
         GROUP  BY p.id, p.project_name, p.project_type,
                   u.country, u.state, u.district, p.location
         ORDER  BY total_absorbed DESC
         LIMIT  300`,
        values
      )).rows;
    } catch {
      rows = [];
    }

    const featureCollection = {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
          project_id:     r.project_id,
          project_name:   r.project_name,
          project_type:   r.project_type,
          country:        r.country,
          state:          r.state,
          district:       r.district,
          total_absorbed: Number(r.total_absorbed) || 0,
          total_hectares: Number(r.total_hectares) || 0,
          latest_year:    r.latest_year,
          unit:           't CO₂e',
        },
      })),
    };
    return res.json(featureCollection);
  } catch (err) {
    console.error('gis/absorption-map error:', err.message);
    return res.json({ type: 'FeatureCollection', features: [], error: err.message });
  }
});

module.exports = router;

// routes/projects.js — Project Management Service
// POST /api/projects                        → create project
// GET  /api/projects/:id                    → get project
// POST /api/projects/:id/emission           → submit emission record (via Python engine)
// GET  /api/projects/:id/emission           → get emission records for project
// POST /api/projects/:id/absorption         → submit absorption record (via Python engine)
// GET  /api/projects/:id/absorption         → get absorption records for project

const router = require("express").Router();
const axios = require("axios");
const pool = require("../config/db");
const auth = require("../middleware/auth");
const { body, validationResult } = require("express-validator");
const { PROJECT_TYPES } = require("../config/projectTypes");

const FASTAPI = process.env.FASTAPI_BASE_URL || "http://localhost:8000";

// ── Helpers ──────────────────────────────────────────────────────────────────
function validationCheck(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return false;
  }
  return true;
}

// ── POST /api/projects ───────────────────────────────────────────────────────
router.post(
  "/",
  auth,
  [
    body("project_name").notEmpty().withMessage("project_name required"),
    body("project_type")
      .notEmpty()
      .withMessage("project_type required")
      .isIn(PROJECT_TYPES)
      .withMessage("project_type must be a supported absorption sink"),
  ],
  async (req, res) => {
    if (!validationCheck(req, res)) return;
    const {
      project_name,
      project_type,
      description,
      country_id,
      state_id,
      district_id,
      latitude,
      longitude,
    } = req.body;

    try {
      const absorptionResult = await pool.query(
        "INSERT INTO absorptions DEFAULT VALUES RETURNING id",
      );
      const absorptionId = absorptionResult.rows[0].id;

      // Build optional POINT geometry if lat/lng provided
      const hasGeom = latitude != null && longitude != null;
      const result = await pool.query(
        `INSERT INTO projects
           (user_id, project_name, project_type, description,
            country_id, state_id, district_id, project_id
            ${hasGeom ? ", location" : ""})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hasGeom ? ",ST_SetSRID(ST_MakePoint($9,$10),4326)" : ""})
         RETURNING *`,
        hasGeom
          ? [
              req.user.id,
              project_name,
              project_type,
              description || null,
              country_id || null,
              state_id || null,
              district_id || null,
              absorptionId,
              parseFloat(longitude),
              parseFloat(latitude),
            ]
          : [
              req.user.id,
              project_name,
              project_type,
              description || null,
              country_id || null,
              state_id || null,
              district_id || null,
              absorptionId,
            ],
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("project create error:", err.message);
      return res
        .status(500)
        .json({ error: "Failed to create project", detail: err.message });
    }
  },
);

// ── GET /api/projects/:id ────────────────────────────────────────────────────
router.get("/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              u.organisation_name, u.country, u.state, u.district,
              ST_AsGeoJSON(p.location)::json AS geojson
       FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Project not found" });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("project fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch project" });
  }
});

// ── POST /api/projects/:id/emission ─────────────────────────────────────────
// Sends payload to Python accounting engine, saves result to DB
router.post("/:id/emission", auth, async (req, res) => {
  const project_id = req.params.id;
  try {
    // 1. Verify project exists + belongs to user
    const proj = await pool.query(
      "SELECT * FROM projects WHERE id=$1 AND user_id=$2",
      [project_id, req.user.id],
    );
    if (!proj.rows.length)
      return res.status(404).json({ error: "Project not found or not yours" });

    // 2. Build payload for Python engine
    const {
      scope1,
      scope2,
      scope3,
      forest_area_m2,
      tree_count,
      other_absorption_co2e,
      reporting_year,
      industry_type,
    } = req.body;

    const fastapiPayload = {
      project_id: String(project_id),
      scope1: scope1 || null,
      scope2: scope2 || null,
      scope3: scope3 || null,
      forest_area_m2: forest_area_m2 || null,
      tree_count: tree_count || null,
      other_absorption_co2e: other_absorption_co2e || null,
    };

    // 3. Call Python accounting engine
    let calcData;
    try {
      const fastapiRes = await axios.post(
        `${FASTAPI}/api/v1/emission/calculate`,
        fastapiPayload,
        { timeout: 15000 },
      );
      calcData = fastapiRes.data;
    } catch (pyErr) {
      console.error(
        "Python engine error:",
        pyErr.response?.data || pyErr.message,
      );
      return res.status(502).json({
        error: "Carbon accounting engine unavailable",
        detail: pyErr.response?.data?.detail || pyErr.message,
      });
    }

    // 4. Save to emission_records (existing table kept intact)
    const year = reporting_year || new Date().getFullYear();
    const gwt = calcData.gas_wise_totals || {};

    // Upsert buyer_profiles (existing logic preserved)
    const bpResult = await pool.query(
      `INSERT INTO buyer_profiles (user_id, reporting_year, industry_type)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, reporting_year)
       DO UPDATE SET industry_type=EXCLUDED.industry_type
       RETURNING id`,
      [req.user.id, year, industry_type || scope1?.industry_type || "general"],
    );
    const buyerId = bpResult.rows[0].id;

    await pool.query(
      `INSERT INTO emission_records
         (buyer_id, scope1_co2e, scope2_co2e, scope3_co2e, total_co2e,
          gas_co2, gas_ch4, gas_n2o, gas_hfc134a, gas_sf6,
          total_absorption, net_balance, offset_ratio_pct,
          raw_input, sector_breakdown, sink_breakdown, year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        buyerId,
        calcData.scope1_co2e || 0,
        calcData.scope2_co2e || 0,
        calcData.scope3_co2e || 0,
        calcData.total_emission_co2e || 0,
        gwt.CO2 || 0,
        gwt.CH4 || 0,
        gwt.N2O || 0,
        gwt["HFC-134a"] || 0,
        gwt.SF6 || 0,
        calcData.total_absorption_co2e || 0,
        calcData.net_balance || 0,
        calcData.offset_ratio_percent || 0,
        JSON.stringify(req.body),
        JSON.stringify(calcData.sector_breakdown || {}),
        JSON.stringify(calcData.sink_breakdown || {}),
        year,
      ],
    );

    // 5. Also insert into new `emissions` table (doc schema)
    await pool
      .query(
        `INSERT INTO emissions (project_id, co2_amount, unit, year)
       VALUES ($1,$2,'tonnes',$3)
       ON CONFLICT DO NOTHING`,
        [project_id, calcData.total_emission_co2e || 0, year],
      )
      .catch(() => {}); // graceful: table may not exist yet
    return res.json({ ...calcData, project_id, year });
  } catch (err) {
    console.error("project emission error:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to save emission", detail: err.message });
  }
});

// ── GET /api/projects/:id/emission ──────────────────────────────────────────
router.get("/:id/emission", auth, async (req, res) => {
  try {
    // Try new emissions table first, fall back to emission_records via buyer_profiles
    let result;
    try {
      result = await pool.query(
        "SELECT * FROM emissions WHERE project_id=$1 ORDER BY year DESC",
        [req.params.id],
      );
    } catch {
      result = { rows: [] };
    }

    if (!result.rows.length) {
      // Fallback: emission_records joined through buyer_profiles
      const fb = await pool
        .query(
          `SELECT er.*, bp.reporting_year AS year
         FROM emission_records er
         JOIN buyer_profiles bp ON bp.id = er.buyer_id
         JOIN users u ON u.id = bp.user_id
         WHERE u.id = $1
         ORDER BY er.year DESC`,
          [req.user.id],
        )
        .catch(() => ({ rows: [] }));
      return res.json(fb.rows);
    }
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch emission records" });
  }
});

// ── POST /api/projects/:id/absorption ───────────────────────────────────────
router.post("/:id/absorption", auth, async (req, res) => {
  const project_id = req.params.id;
  try {
    const proj = await pool.query(
      "SELECT * FROM projects WHERE id=$1 AND user_id=$2",
      [project_id, req.user.id],
    );
    if (!proj.rows.length)
      return res.status(404).json({ error: "Project not found or not yours" });

    const {
      year,
      area_m2,
      tree_count,
      other_absorption_co2e,
      wetland,
      forest,
      trees,
      carbon_sink_tech,
      coastal,
      eco_park,
      river,
    } = req.body;

    const absorptionId = proj.rows[0].project_id;
    const area = parseFloat(area_m2);
    const treesCount = parseInt(tree_count);
    const other = parseFloat(other_absorption_co2e);
    const hasSinks =
      wetland ||
      forest ||
      trees ||
      carbon_sink_tech ||
      coastal ||
      eco_park ||
      river;

    const payload = hasSinks
      ? {
          project_id: String(project_id),
          wetland: wetland || null,
          forest: forest || null,
          trees: trees || null,
          carbon_sink_tech: carbon_sink_tech || null,
          coastal: coastal || null,
          eco_park: eco_park || null,
          river: river || null,
        }
      : {
          project_id: String(project_id),
          forest: Number.isFinite(area) ? { area_m2: area } : null,
          trees: Number.isFinite(treesCount)
            ? { number_of_trees: treesCount }
            : null,
          carbon_sink_tech: Number.isFinite(other)
            ? { co2_captured_tonnes_per_year: other }
            : null,
        };

    const fastapiRes = await axios.post(
      `${FASTAPI}/api/v1/absorption/calculate`,
      payload,
      { timeout: 15000 },
    );
    const calcData = fastapiRes.data;

    const absorbedValue = calcData.total_absorption_co2e || 0;
    const recordYear = year || new Date().getFullYear();

    const areaM2Total = [
      wetland?.area_m2,
      forest?.area_m2,
      coastal?.area_m2,
      eco_park?.area_m2,
      river?.area_m2,
      !hasSinks && Number.isFinite(area) ? area : null,
    ]
      .filter((v) => Number.isFinite(v))
      .reduce((sum, v) => sum + v, 0);
    const areaHectares = areaM2Total > 0 ? areaM2Total / 10000 : null;

    const updateRes = await pool.query(
      `UPDATE absorptions
       SET co2_absorbed=$1, area_hectares=$2, year=$3
       WHERE id=$4`,
      [absorbedValue, areaHectares, recordYear, absorptionId],
    );
    if (!updateRes.rowCount) {
      await pool.query(
        `INSERT INTO absorptions (id, co2_absorbed, area_hectares, year)
         VALUES ($1,$2,$3,$4)`,
        [absorptionId, absorbedValue, areaHectares, recordYear],
      );
    }

    return res.json({
      project_id,
      co2_absorbed: absorbedValue,
      area_hectares: areaHectares,
      year: recordYear,
      engine_result: calcData || null,
      scientific_standard: "IPCC 2006 + 2019 Refinement | GWP-100 AR5",
    });
  } catch (err) {
    console.error("project absorption error:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to save absorption", detail: err.message });
  }
});

// ── GET /api/projects/:id/absorption ────────────────────────────────────────
router.get("/:id/absorption", auth, async (req, res) => {
  try {
    const result = await pool
      .query(
        `SELECT a.*
         FROM projects p
         JOIN absorptions a ON a.id = p.project_id
         WHERE p.id = $1
         ORDER BY a.year DESC`,
        [req.params.id],
      )
      .catch(() => ({ rows: [] }));
    return res.json(result.rows);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to fetch absorption records" });
  }
});

module.exports = router;

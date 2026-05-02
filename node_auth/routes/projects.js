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

async function insertEcoProjectPoint({
  project_id,
  latitude,
  longitude,
  name,
  co2capture,
  hectares,
  district_id = null,
}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    console.warn("eco_projects insert skipped: invalid project location", {
      project_id,
      projectLatitude: latitude,
      projectLongitude: longitude,
    });
    return;
  }

  const geomExprs = {
    POINT: "ST_SetSRID(ST_MakePoint($1,$2),4326)",
    POINTM: "ST_SetSRID(ST_MakePointM($1,$2,0),4326)",
    POINTZ: "ST_SetSRID(ST_MakePoint($1,$2,0),4326)",
    MULTIPOINTZM:
      "ST_Multi(ST_SetSRID(ST_MakePoint($1,$2,0,0),4326))",
  };

  const attemptInsert = async (geomName, geomExpr) => {
    console.log("eco_projects insert attempt", {
      project_id,
      geomName,
      latitude,
      longitude,
      name: name || null,
      co2capture: co2capture || 0,
      hectares,
      district_id,
    });
    return pool.query(
      `INSERT INTO eco_projects
         (geom, name, co2capture, hectares, district_id)
       VALUES (
         ${geomExpr},
         $3, $4, $5, $6
       )`,
      [longitude, latitude, name || null, co2capture || 0, hectares, district_id],
    );
  };

  let insertErr;
  for (const [geomName, geomExpr] of Object.entries(geomExprs)) {
    try {
      await attemptInsert(geomName, geomExpr);
      console.log("eco_projects insert success", {
        project_id,
        geomName,
      });
      return;
    } catch (err) {
      console.warn("eco_projects insert variant failed", {
        project_id,
        geomName,
        message: err.message,
        code: err.code,
      });
      insertErr = err;
    }
  }

  if (insertErr) {
    console.error(
      "eco_projects insert failed",
      {
        name: insertErr.name,
        message: insertErr.message,
        code: insertErr.code,
        detail: insertErr.detail,
        hint: insertErr.hint,
        position: insertErr.position,
      },
      {
        project_id,
        projectLatitude: latitude,
        projectLongitude: longitude,
        projectName: name || null,
        co2capture: co2capture || 0,
        hectares,
        district_id,
      },
    );
  }
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
      // Build optional POINT geometry if lat/lng provided
      const hasGeom = latitude != null && longitude != null;
      const result = await pool.query(
        `INSERT INTO projects
           (user_id, project_name, project_type, description,
            country_id, state_id, district_id
            ${hasGeom ? ", location" : ""})
         VALUES ($1,$2,$3,$4,$5,$6,$7${hasGeom ? ",ST_SetSRID(ST_MakePoint($8,$9),4326)" : ""})
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
            ],
      );
      const project = result.rows[0];

      await pool.query("INSERT INTO absorptions (project_id) VALUES ($1)", [
        project.id,
      ]);

      return res.status(201).json(project);
    } catch (err) {
      console.error("project create error:", err.message);
      return res
        .status(500)
        .json({ error: "Failed to create project", detail: err.message });
    }
  },
);

// ── POST /api/projects/emission/calculate ───────────────────────────────────
router.post("/emission/calculate", auth, async (req, res) => {
  try {
    const {
      project_id,
      reporting_year,
      industry_type,
      scope1,
      scope2,
      scope3,
      forest_area_m2,
      tree_count,
      other_absorption_co2e,
      latitude,
      longitude,
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

    const year = reporting_year || new Date().getFullYear();
    const gwt = calcData.gas_wise_totals || {};

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

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      console.warn(
        "emitter_table_pointer insert skipped: invalid coordinates",
        {
          project_id,
          latitude,
          longitude,
        },
      );
    } else {
      const buyerName = req.user.organisation_name || `buyer-${req.user.id}`;
      const districtName = req.user.district || null;
      try {
        await pool.query(
          `INSERT INTO emitter_table_pointer
             (geom, name, district_id, co2, co, ch4, so2, nh3, area_msq)
           VALUES (
             ST_SetSRID(ST_MakePoint($1,$2),4326),
             $3, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            longitude,
            latitude,
            buyerName,
            null,
            gwt.CO2 || 0,
            0,
            gwt.CH4 || 0,
            0,
            0,
            calcData.total_emission_co2e || 0,
          ],
        );
      } catch (insertErr) {
        console.error(
          "emitter_table_pointer insert failed",
          {
            name: insertErr.name,
            message: insertErr.message,
            code: insertErr.code,
            detail: insertErr.detail,
            hint: insertErr.hint,
            position: insertErr.position,
          },
          {
            project_id,
            latitude,
            longitude,
            co2: gwt.CO2 || 0,
            ch4: gwt.CH4 || 0,
            total_emission_co2e: calcData.total_emission_co2e || 0,
            districtName,
          },
        );
      }
    }

    const buyerName = req.user.organisation_name || `buyer-${req.user.id}`;
    const buyerAreaM2 = parseFloat(forest_area_m2);
    const buyerAreaHectares =
      Number.isFinite(buyerAreaM2) && buyerAreaM2 > 0 ? buyerAreaM2 / 10000 : null;
    await insertEcoProjectPoint({
      project_id,
      latitude,
      longitude,
      name: buyerName,
      co2capture: calcData.total_absorption_co2e || 0,
      hectares: buyerAreaHectares,
    });

    return res.json({ ...calcData, project_id, year });
  } catch (err) {
    console.error("project emission calculate error:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to calculate emission", detail: err.message });
  }
});

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
      `SELECT p.*, ST_X(p.location) AS longitude, ST_Y(p.location) AS latitude
       FROM projects p
       WHERE p.id=$1 AND p.user_id=$2`,
      [project_id, req.user.id],
    );
    if (!proj.rows.length)
      return res.status(404).json({ error: "Project not found or not yours" });

    const latitude = proj.rows[0].latitude;
    const longitude = proj.rows[0].longitude;

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

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      console.warn(
        "emitter_table_pointer insert skipped: invalid coordinates",
        {
          project_id,
          latitude,
          longitude,
        },
      );
    } else {
      const buyerName = req.user.organisation_name || `buyer-${req.user.id}`;
      const districtName = req.user.district || null;
      try {
        await pool.query(
          `INSERT INTO emitter_table_pointer
             (geom, name, district_id, co2, co, ch4, so2, nh3, area_msq)
           VALUES (
             ST_SetSRID(ST_MakePoint($1,$2),4326),
             $3, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            longitude,
            latitude,
            buyerName,
            null,
            gwt.CO2 || 0,
            0,
            gwt.CH4 || 0,
            0,
            0,
            calcData.total_emission_co2e || 0,
          ],
        );
      } catch (insertErr) {
        console.error(
          "emitter_table_pointer insert failed",
          {
            name: insertErr.name,
            message: insertErr.message,
            code: insertErr.code,
            detail: insertErr.detail,
            hint: insertErr.hint,
            position: insertErr.position,
          },
          {
            project_id,
            latitude,
            longitude,
            co2: gwt.CO2 || 0,
            ch4: gwt.CH4 || 0,
            total_emission_co2e: calcData.total_emission_co2e || 0,
            districtName,
          },
        );
      }
    }

    const buyerName = req.user.organisation_name || `buyer-${req.user.id}`;
    const buyerAreaM2 = parseFloat(forest_area_m2);
    const buyerAreaHectares =
      Number.isFinite(buyerAreaM2) && buyerAreaM2 > 0 ? buyerAreaM2 / 10000 : null;
    await insertEcoProjectPoint({
      project_id,
      latitude,
      longitude,
      name: buyerName,
      co2capture: calcData.total_absorption_co2e || 0,
      hectares: buyerAreaHectares,
      district_id: proj.rows[0].district_id || null,
    });

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
      `SELECT p.*, ST_X(p.location) AS longitude, ST_Y(p.location) AS latitude
       FROM projects p
       WHERE p.id=$1 AND p.user_id=$2`,
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

    const absorptionSelect = await pool.query(
      `SELECT id FROM absorptions WHERE project_id=$1`,
      [project_id],
    );
    let absorptionId;
    if (absorptionSelect.rows.length) {
      absorptionId = absorptionSelect.rows[0].id;
    } else {
      const insertedAbsorption = await pool.query(
        `INSERT INTO absorptions (project_id) VALUES ($1) RETURNING id`,
        [project_id],
      );
      absorptionId = insertedAbsorption.rows[0].id;
    }

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
        `INSERT INTO absorptions (id, project_id, co2_absorbed, area_hectares, year)
         VALUES ($1, $2, $3, $4, $5)`,
        [absorptionId, project_id, absorbedValue, areaHectares, recordYear],
      );
    }

    await insertEcoProjectPoint({
      project_id,
      latitude: proj.rows[0].latitude,
      longitude: proj.rows[0].longitude,
      name: proj.rows[0].project_name || null,
      co2capture: absorbedValue,
      hectares: areaHectares,
      district_id: proj.rows[0].district_id || null,
    });

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
         JOIN absorptions a ON a.project_id = p.id
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

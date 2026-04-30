// routes/carbon.js — proxies calculation requests to FastAPI
const router = require("express").Router();
const axios = require("axios");
const pool = require("../config/db");
const auth = require("../middleware/auth");
const { PROJECT_TYPES } = require("../config/projectTypes");

const FASTAPI = process.env.FASTAPI_BASE_URL || "http://localhost:8000";

// ── POST /carbon/emission/calculate ────────────────────────
// Deprecated: buyer emission calculation has been moved to /api/projects/emission/calculate
// The route is removed from active use to avoid duplicate request handling.

// // ── POST /carbon/seller/calculate ──────────────────────────
// router.post("/seller/calculate", auth, async (req, res) => {
//   try {
//     const fastapiRes = await axios.post(
//       `${FASTAPI}/api/v1/seller/calculate`,
//       req.body,
//     );
//     res.json(fastapiRes.data);
//   } catch (err) {
//     res
//       .status(err.response?.status || 500)
//       .json({ error: err.response?.data?.detail || "Failed" });
//   }
// });

// // ── GET /carbon/dashboard/summary ──────────────────────────
// router.get("/dashboard/summary", auth, async (req, res) => {
//   const { country, state, district } = req.query;
//   try {
//     const filters = [];
//     const values = [];
//     if (country && String(country).trim()) {
//       values.push(String(country).trim());
//       filters.push(`LOWER(TRIM(u.country)) = LOWER(TRIM($${values.length}))`);
//     }
//     if (state && String(state).trim()) {
//       values.push(String(state).trim());
//       filters.push(`LOWER(TRIM(u.state)) = LOWER(TRIM($${values.length}))`);
//     }
//     if (district && String(district).trim()) {
//       values.push(String(district).trim());
//       filters.push(`LOWER(TRIM(u.district)) = LOWER(TRIM($${values.length}))`);
//     }
//     const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

//     const emissionRes = await pool.query(
//       `SELECT er.year::int AS year,
//               COALESCE(SUM(er.total_co2e), 0) AS emission_co2e,
//               COALESCE(SUM(er.total_absorption), 0) AS absorption_co2e
//        FROM emission_records er
//        JOIN buyer_profiles bp ON bp.id = er.buyer_id
//        JOIN users u ON u.id = bp.user_id
//        ${whereClause}
//        GROUP BY er.year
//        ORDER BY er.year`,
//       values,
//     );

//     const tradedRes = await pool.query(
//       `SELECT EXTRACT(YEAR FROM ct.trade_date)::int AS year,
//               COALESCE(SUM(ct.credits_traded), 0) AS credits_value
//        FROM carbon_transactions ct
//        JOIN users u ON u.id = ct.buyer_id
//        ${whereClause}
//        GROUP BY EXTRACT(YEAR FROM ct.trade_date)
//        ORDER BY year`,
//       values,
//     );

//     const vintageColRes = await pool.query(
//       `SELECT column_name
//        FROM information_schema.columns
//        WHERE table_schema = 'public'
//          AND table_name = 'seller_projects'
//          AND column_name IN ('vintage', 'vintage_start')
//        ORDER BY CASE WHEN column_name = 'vintage' THEN 0 ELSE 1 END
//        LIMIT 1`,
//     );
//     const vintageCol = vintageColRes.rows[0]?.column_name;
//     const generatedRes = vintageCol
//       ? await pool.query(
//           `SELECT sp.${vintageCol}::int AS year,
//                   COALESCE(SUM(sp.credits_available), 0) AS credits_value
//            FROM seller_projects sp
//            JOIN users u ON u.id = sp.user_id
//            ${whereClause}
//            GROUP BY sp.${vintageCol}
//            ORDER BY sp.${vintageCol}`,
//           values,
//         )
//       : { rows: [] };

//     const creditsByYear = new Map();
//     tradedRes.rows.forEach((r) => {
//       creditsByYear.set(Number(r.year), Number(r.credits_value) || 0);
//     });
//     generatedRes.rows.forEach((r) => {
//       const y = Number(r.year);
//       const existing = creditsByYear.get(y) || 0;
//       creditsByYear.set(y, Math.max(existing, Number(r.credits_value) || 0));
//     });

//     const yearly_trend = emissionRes.rows.map((r) => ({
//       year: Number(r.year),
//       emission_co2e: Number(r.emission_co2e) || 0,
//       absorption_co2e: Number(r.absorption_co2e) || 0,
//       credits_traded: creditsByYear.get(Number(r.year)) || 0,
//     }));

//     const totals = yearly_trend.reduce(
//       (acc, row) => {
//         acc.emission += row.emission_co2e;
//         acc.absorption += row.absorption_co2e;
//         return acc;
//       },
//       { emission: 0, absorption: 0 },
//     );
//     const emissionBase = totals.emission || 1;

//     return res.json({
//       yearly_trend,
//       top_indicators: {
//         absorption_pct: (totals.absorption / emissionBase) * 100,
//         emission_pct:
//           ((totals.emission - totals.absorption) / emissionBase) * 100,
//       },
//       unit: "t CO2e",
//     });
//   } catch (err) {
//     console.error("Dashboard summary failed:", err.message);
//     return res.status(500).json({ error: "Dashboard summary failed" });
//   }
// });

// ── GET /carbon/dashboard/region ───────────────────────────
router.get("/dashboard/region", auth, async (req, res) => {
  const { country, state, district } = req.query;
  try {
    const filters = [];
    const values = [];
    if (country && String(country).trim()) {
      values.push(String(country).trim());
      filters.push(`LOWER(TRIM(u.country)) = LOWER(TRIM($${values.length}))`);
    }
    if (state && String(state).trim()) {
      values.push(String(state).trim());
      filters.push(`LOWER(TRIM(u.state)) = LOWER(TRIM($${values.length}))`);
    }
    if (district && String(district).trim()) {
      values.push(String(district).trim());
      filters.push(`LOWER(TRIM(u.district)) = LOWER(TRIM($${values.length}))`);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const resolution = district
      ? "district"
      : state
        ? "district"
        : country
          ? "state"
          : "country";
    const groupExpr =
      resolution === "country"
        ? "u.country"
        : resolution === "state"
          ? "u.country, u.state"
          : "u.country, u.state, u.district";

    const result = await pool.query(
      `SELECT u.country,
              ${resolution === "country" ? "NULL::text AS state," : "u.state,"}
              ${resolution === "district" ? "u.district," : "NULL::text AS district,"}
              COALESCE(SUM(er.total_co2e), 0) AS total_emission_co2e,
              COALESCE(SUM(er.total_absorption), 0) AS total_absorption_co2e
       FROM emission_records er
       JOIN buyer_profiles bp ON bp.id = er.buyer_id
       JOIN users u ON u.id = bp.user_id
       ${whereClause}
       GROUP BY ${groupExpr}
       ORDER BY total_emission_co2e DESC
       LIMIT 100`,
      values,
    );

    return res.json({
      regions: result.rows.map((r) => ({
        country: r.country,
        state: r.state,
        district: r.district,
        total_emission_co2e: Number(r.total_emission_co2e) || 0,
        total_absorption_co2e: Number(r.total_absorption_co2e) || 0,
      })),
      resolution,
      unit: "t CO2e",
    });
  } catch (err) {
    return res.status(500).json({ error: "Region data failed" });
  }
});

// ── GET /carbon/districts ──────────────────────────────────────
router.get("/districts", auth, async (req, res) => {
  const { state, country } = req.query;
  if (!state || !String(state).trim()) {
    return res.status(400).json({ error: "state query param is required" });
  }

  try {
    const vals = [String(state).trim()];
    let where = "WHERE state = $1";
    if (country && String(country).trim()) {
      vals.push(String(country).trim());
      where += " AND country = $2";
    }

    const result = await pool.query(
      `SELECT DISTINCT district AS name
       FROM users
       ${where}
       AND district IS NOT NULL
       AND TRIM(district) <> ''
       ORDER BY district ASC`,
      vals,
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: "Failed to load districts" });
  }
});

// ── GET /carbon/marketplace ─────────────────────────────────
router.get("/marketplace", auth, async (req, res) => {
  const { project_type, min_price, max_price, vintage } = req.query;
  if (project_type && !PROJECT_TYPES.includes(project_type)) {
    return res.status(400).json({ error: "Unsupported project_type" });
  }
  let query = `SELECT sp.*, u.organisation_name, u.country, u.state
               FROM seller_projects sp
               JOIN users u ON u.id = sp.user_id
               WHERE sp.status='active' AND sp.credits_available > 0`;
  const params = [];
  if (project_type) {
    params.push(project_type);
    query += ` AND sp.project_type=$${params.length}`;
  }
  if (min_price) {
    params.push(min_price);
    query += ` AND sp.price_per_credit>=$${params.length}`;
  }
  if (max_price) {
    params.push(max_price);
    query += ` AND sp.price_per_credit<=$${params.length}`;
  }
  if (vintage) {
    params.push(vintage);
    query += ` AND sp.vintage_start<=$${params.length} AND sp.vintage_end>=$${params.length}`;
  }
  query += " ORDER BY sp.price_per_credit ASC LIMIT 50";
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ── POST /carbon/trade ──────────────────────────────────────
router.post("/trade", auth, async (req, res) => {
  const { project_id, credits } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proj = await client.query(
      "SELECT * FROM seller_projects WHERE id=$1 AND status=$2 FOR UPDATE",
      [project_id, "active"],
    );
    if (!proj.rows.length) throw new Error("Project not found or inactive");
    const p = proj.rows[0];
    if (p.credits_available < credits)
      throw new Error("Insufficient credits available");
    const total = credits * p.price_per_credit;
    await client.query(
      `INSERT INTO carbon_transactions
         (buyer_id,seller_id,project_id,credits_traded,price_per_credit,total_value)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, p.user_id, project_id, credits, p.price_per_credit, total],
    );
    await client.query(
      "UPDATE seller_projects SET credits_available=credits_available-$1 WHERE id=$2",
      [credits, project_id],
    );
    await client.query("COMMIT");
    res.json({
      message: "Trade successful",
      total_value: total,
      credits_traded: credits,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

// ── GET /carbon/absorption/calculate ────────────────────────────────────────
// Proxies absorption parameters to Python engine. Returns calculated CO2e absorbed.
// Params: area_m2, tree_count, other_absorption_co2e
// router.get("/absorption/calculate", auth, async (req, res) => {
//   const { area_m2, tree_count, other_absorption_co2e } = req.query;
//   try {
//     const area = parseFloat(area_m2);
//     const trees = parseInt(tree_count);
//     const other = parseFloat(other_absorption_co2e);
//     const fastapiRes = await axios.post(
//       `${FASTAPI}/api/v1/absorption/calculate`,
//       {
//         project_id: "absorption-calc-" + Date.now(),
//         forest: Number.isFinite(area) ? { area_m2: area } : null,
//         trees: Number.isFinite(trees) ? { number_of_trees: trees } : null,
//         carbon_sink_tech: Number.isFinite(other)
//           ? { co2_captured_tonnes_per_year: other }
//           : null,
//       },
//       { timeout: 10000 },
//     );
//     return res.json(fastapiRes.data);
//   } catch (err) {
//     return res
//       .status(502)
//       .json({ error: "Python accounting engine unavailable" });
//   }
// });

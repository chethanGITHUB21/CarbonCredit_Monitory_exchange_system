// routes/dashboard.js — Dashboard & Analytics Service
//
// GET /api/dashboard/yearly
//     → Yearly emission vs absorption trend (line graph data)
//     → Source: emission_records + absorptions joined through projects/users
//
// GET /api/dashboard/regional?country={id}
// GET /api/dashboard/regional?country={id}&state={id}
// GET /api/dashboard/regional?country={id}&state={id}&district={id}
//     → Regional aggregation (bar graph data)
//     → Resolution auto-drills: no filter→country, +country→state, +state→district
//
// IMPORTANT: All filters use TEXT matching on users.country/state/district columns.
// The district table (GIS) is separate; these routes query the denormalised
// user registration strings for dashboard aggregation (fast, no PostGIS needed).

const router = require('express').Router();
const pool   = require('../config/db');
const auth   = require('../middleware/auth');

// ── Shared: build WHERE clause from country/state/district query params ───────
function buildFilter(query, tableAlias = 'u') {
  const { country, state, district } = query;
  const filters = [];
  const values  = [];

  if (country && String(country).trim()) {
    values.push(String(country).trim());
    filters.push(`LOWER(TRIM(${tableAlias}.country)) = LOWER(TRIM($${values.length}))`);
  }
  if (state && String(state).trim()) {
    values.push(String(state).trim());
    filters.push(`LOWER(TRIM(${tableAlias}.state)) = LOWER(TRIM($${values.length}))`);
  }
  if (district && String(district).trim()) {
    values.push(String(district).trim());
    filters.push(`LOWER(TRIM(${tableAlias}.district)) = LOWER(TRIM($${values.length}))`);
  }

  return {
    where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    values,
  };
}

// ── GET /api/dashboard/yearly ────────────────────────────────────────────────
// Returns yearly_trend array: { year, emission_co2e, absorption_co2e, credits_traded }
// Supports optional country/state/district filters.
// Queries two independent subqueries to avoid Cartesian products.
router.get('/yearly', auth, async (req, res) => {
  try {
    const { where, values } = buildFilter(req.query);

    // Subquery A: yearly emission + absorption from emission_records
    const emissionSQL = `
      SELECT er.year::int                        AS year,
             COALESCE(SUM(er.total_co2e), 0)     AS emission_co2e,
             COALESCE(SUM(er.total_absorption),0) AS absorption_co2e
      FROM   emission_records er
      JOIN   buyer_profiles bp ON bp.id = er.buyer_id
      JOIN   users          u  ON u.id  = bp.user_id
      ${where}
      GROUP  BY er.year
      ORDER  BY er.year`;

    // Subquery B: credits traded per year
    const creditsSQL = `
      SELECT EXTRACT(YEAR FROM ct.trade_date)::int AS year,
             COALESCE(SUM(ct.credits_traded), 0)  AS credits_traded
      FROM   carbon_transactions ct
      JOIN   users u ON u.id = ct.buyer_id
      ${where}
      GROUP  BY EXTRACT(YEAR FROM ct.trade_date)
      ORDER  BY year`;

    const [emRes, crRes] = await Promise.all([
      pool.query(emissionSQL, values),
      pool.query(creditsSQL,  values),
    ]);

    // Merge by year
    const creditMap = new Map();
    crRes.rows.forEach(r => creditMap.set(Number(r.year), Number(r.credits_traded) || 0));

    const yearly_trend = emRes.rows.map(r => ({
      year:            Number(r.year),
      emission_co2e:   Number(r.emission_co2e)   || 0,
      absorption_co2e: Number(r.absorption_co2e) || 0,
      credits_traded:  creditMap.get(Number(r.year)) || 0,
    }));

    // Top indicators
    const totals = yearly_trend.reduce(
      (acc, r) => { acc.emission += r.emission_co2e; acc.absorption += r.absorption_co2e; return acc; },
      { emission: 0, absorption: 0 }
    );
    const base = totals.emission || 1;

    return res.json({
      yearly_trend,
      top_indicators: {
        absorption_pct: (totals.absorption / base) * 100,
        emission_pct:   ((totals.emission - totals.absorption) / base) * 100,
      },
      unit:      't CO₂e',
      gwp_basis: 'AR5 GWP-100 | CO₂=1 CH₄=28 N₂O=265 HFC-134a=1300 SF₆=23500',
    });
  } catch (err) {
    console.error('dashboard/yearly error:', err.message);
    return res.status(500).json({ error: 'Dashboard yearly query failed', detail: err.message });
  }
});

// ── GET /api/dashboard/regional ──────────────────────────────────────────────
// Auto-resolution:
//   no params          → group by country
//   ?country=X         → group by state (within country)
//   ?country=X&state=Y → group by district (within state)
//   all three set      → group by district (most granular)
router.get('/regional', auth, async (req, res) => {
  try {
    const { country, state, district } = req.query;
    const { where, values } = buildFilter(req.query);

    // Determine grouping resolution
    let resolution, groupBy, selectCols;
    if (district && String(district).trim()) {
      resolution = 'district';
      groupBy    = 'u.country, u.state, u.district';
      selectCols = 'u.country, u.state, u.district';
    } else if (state && String(state).trim()) {
      resolution = 'district';
      groupBy    = 'u.country, u.state, u.district';
      selectCols = 'u.country, u.state, u.district';
    } else if (country && String(country).trim()) {
      resolution = 'state';
      groupBy    = 'u.country, u.state';
      selectCols = 'u.country, u.state, NULL::text AS district';
    } else {
      resolution = 'country';
      groupBy    = 'u.country';
      selectCols = 'u.country, NULL::text AS state, NULL::text AS district';
    }

    const sql = `
      SELECT ${selectCols},
             COALESCE(SUM(er.total_co2e), 0)      AS total_emission_co2e,
             COALESCE(SUM(er.total_absorption), 0) AS total_absorption_co2e,
             COALESCE(SUM(er.net_balance), 0)      AS net_balance_co2e,
             COUNT(DISTINCT er.buyer_id)            AS num_organisations
      FROM   emission_records er
      JOIN   buyer_profiles bp ON bp.id = er.buyer_id
      JOIN   users          u  ON u.id  = bp.user_id
      ${where}
      GROUP  BY ${groupBy}
      ORDER  BY total_emission_co2e DESC
      LIMIT  100`;

    const result = await pool.query(sql, values);

    return res.json({
      regions: result.rows.map(r => ({
        country:               r.country,
        state:                 r.state   || null,
        district:              r.district || null,
        total_emission_co2e:   Number(r.total_emission_co2e)   || 0,
        total_absorption_co2e: Number(r.total_absorption_co2e) || 0,
        net_balance_co2e:      Number(r.net_balance_co2e)      || 0,
        num_organisations:     Number(r.num_organisations)      || 0,
      })),
      resolution,
      unit:   't CO₂e',
      filter: { country: country || null, state: state || null, district: district || null },
    });
  } catch (err) {
    console.error('dashboard/regional error:', err.message);
    return res.status(500).json({ error: 'Dashboard regional query failed', detail: err.message });
  }
});

module.exports = router;

// routes/credits.js — Transaction & Marketplace Service
// POST /api/credits              → list new credits from a seller project
// POST /api/credits/purchase     → buyer purchases credits (atomic)
// GET  /api/credits/calculate    → calculate net credits (Python engine)
// GET  /api/credits/listing      → active marketplace listings
// GET  /api/credits/transaction  → transaction history for current user

const router = require("express").Router();
const axios = require("axios");
const pool = require("../config/db");
const auth = require("../middleware/auth");
const { body, query, validationResult } = require("express-validator");
const { PROJECT_TYPES } = require("../config/projectTypes");

const FASTAPI = process.env.FASTAPI_BASE_URL || "http://localhost:8000";

function vCheck(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    res.status(422).json({ errors: e.array() });
    return false;
  }
  return true;
}

// ── GET /api/credits/listing ─────────────────────────────────────────────────
// Returns all active listings (from seller_projects, backwards-compat with existing UI)
router.get("/listing", auth, async (req, res) => {
  const { project_type, min_price, max_price, vintage } = req.query;
  if (project_type && !PROJECT_TYPES.includes(project_type)) {
    return res.status(400).json({ error: "Unsupported project_type" });
  }
  // Validate numeric params
  if (min_price && isNaN(parseFloat(min_price)))
    return res.status(400).json({ error: "min_price must be numeric" });
  if (max_price && isNaN(parseFloat(max_price)))
    return res.status(400).json({ error: "max_price must be numeric" });
  if (vintage && isNaN(parseInt(vintage)))
    return res.status(400).json({ error: "vintage must be an integer year" });

  try {
    // Try new credit_listings table first
    let rows = [];
    try {
      const cl = await pool.query(
        `SELECT cl.*, cc.total_credits,
                sp.project_name, sp.project_type, sp.methodology,
                sp.vintage_start, sp.vintage_end, sp.credits_available,
                u.organisation_name, u.country, u.state
         FROM credit_listings cl
         JOIN carbon_credits cc ON cc.id = cl.credit_id
         JOIN users u           ON u.id  = cc.seller_id
         LEFT JOIN LATERAL (
           SELECT *
           FROM seller_projects
           WHERE user_id = u.id
           ORDER BY created_at DESC
           LIMIT 1
         ) sp ON true
         WHERE cl.status = 'approved' AND cl.credits_for_sale > 0
         ORDER BY cl.price_per_credit ASC LIMIT 50`,
      );
      rows = cl.rows;
    } catch {
      // credit_listings table not yet created — fall back to seller_projects
    }

    if (!rows.length) {
      // Fallback: existing seller_projects table (keeps UI working)
      let q = `SELECT sp.*, u.organisation_name, u.country, u.state
               FROM seller_projects sp
               JOIN users u ON u.id = sp.user_id
               WHERE sp.status='active' AND sp.credits_available > 0`;
      const params = [];
      if (project_type) {
        params.push(project_type);
        q += ` AND sp.project_type=$${params.length}`;
      }
      if (min_price) {
        params.push(parseFloat(min_price));
        q += ` AND sp.price_per_credit>=$${params.length}`;
      }
      if (max_price) {
        params.push(parseFloat(max_price));
        q += ` AND sp.price_per_credit<=$${params.length}`;
      }
      if (vintage) {
        const vy = parseInt(vintage);
        params.push(vy);
        const n = params.length;
        q += ` AND sp.vintage_start<=$${n} AND sp.vintage_end>=$${n}`;
      }
      q += " ORDER BY sp.price_per_credit ASC LIMIT 50";
      const fb = await pool.query(q, params);
      rows = fb.rows;
    }
    return res.json(rows);
  } catch (err) {
    console.error("credits listing error:", err.message);
    return res.status(500).json({ error: "Failed to fetch listings" });
  }
});

// ── GET /api/credits/calculate ───────────────────────────────────────────────
// Proxies to Python accounting engine for net-credit calculation
router.get("/calculate", auth, async (req, res) => {
  const { baseline_emission, annual_reduction, leakage, buffer_percent } =
    req.query;
  try {
    const fastapiRes = await axios.post(
      `${FASTAPI}/api/v1/seller/calculate`,
      {
        baseline_emission: parseFloat(baseline_emission) || 0,
        annual_reduction: parseFloat(annual_reduction) || 0,
        leakage: parseFloat(leakage) || 0,
        buffer_percent: parseFloat(buffer_percent) || 10,
      },
      { timeout: 10000 },
    );
    return res.json(fastapiRes.data);
  } catch (err) {
    return res
      .status(502)
      .json({ error: "Python accounting engine unavailable" });
  }
});

// ── POST /api/credits ────────────────────────────────────────────────────────
// Seller creates a new credit listing for their project.
// If credit_listings table exists: inserts there.
// Falls back to existing seller_projects INSERT.
router.post(
  "/",
  auth,
  [
    body("project_name").notEmpty(),
    body("project_type")
      .notEmpty()
      .isIn(PROJECT_TYPES)
      .withMessage("project_type must be a supported absorption sink"),
    body("methodology").notEmpty(),
    body("baseline_emission").isFloat({ min: 0 }),
    body("annual_reduction").isFloat({ min: 0 }),
    body("price_per_credit").isFloat({ min: 0 }),
    body("vintage_start").isInt({ min: 2000 }),
    body("vintage_end").isInt({ min: 2000 }),
  ],
  async (req, res) => {
    if (!vCheck(req, res)) return;
    const {
      project_name,
      project_type,
      methodology,
      baseline_emission,
      annual_reduction,
      leakage = 0,
      buffer_percent = 10,
      price_per_credit,
      vintage_start,
      vintage_end,
      project_boundary,
      verification_doc_url,
      credits_for_sale,
    } = req.body;

    const net_credits = Math.max(
      0,
      (parseFloat(annual_reduction) - parseFloat(leakage)) *
        (1 - parseFloat(buffer_percent) / 100),
    );

    try {
      // Always write to seller_projects (UI depends on this table)
      const sp = await pool.query(
        `INSERT INTO seller_projects
           (user_id, project_name, project_type, methodology,
            baseline_emission, annual_reduction, leakage, buffer_percent,
            credits_available, price_per_credit, vintage_start, vintage_end,
            project_boundary, verification_doc_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
         RETURNING *`,
        [
          req.user.id,
          project_name,
          project_type,
          methodology,
          parseFloat(baseline_emission),
          parseFloat(annual_reduction),
          parseFloat(leakage),
          parseFloat(buffer_percent),
          net_credits,
          parseFloat(price_per_credit),
          parseInt(vintage_start),
          parseInt(vintage_end),
          project_boundary || null,
          verification_doc_url || null,
        ],
      );
      const spRow = sp.rows[0];

      // Normalise numeric fields (pg returns NUMERIC as string)
      [
        "baseline_emission",
        "annual_reduction",
        "leakage",
        "buffer_percent",
        "credits_available",
        "price_per_credit",
      ].forEach((f) => {
        spRow[f] = Number(spRow[f] ?? 0);
      });

      // Also try writing to new carbon_credits + verification + credit_listings tables
      let creditInsertError = null;
      let verificationStatus = null;
      let listingInserted = null;
      try {
        const cc = await pool.query(
          `INSERT INTO carbon_credits
             (seller_id, total_credits, available_credits, price_per_credit)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (seller_id)
           DO UPDATE SET
             total_credits = EXCLUDED.total_credits,
             available_credits = EXCLUDED.available_credits,
             price_per_credit = EXCLUDED.price_per_credit
           RETURNING id`,
          [
            req.user.id,
            net_credits,
            credits_for_sale || net_credits,
            parseFloat(price_per_credit),
          ],
        );

        const verCreditsForSale = Math.round(
          Number(credits_for_sale || net_credits),
        );
        const verTotalCredits = Math.round(Number(net_credits));
        const verificationRes = await pool.query(
          `INSERT INTO verification
             (credit_id, seller_id, credits_for_sale, price_per_credit, total_credits, url_document)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (seller_id)
           DO UPDATE SET
             credit_id = EXCLUDED.credit_id,
             credits_for_sale = EXCLUDED.credits_for_sale,
             price_per_credit = EXCLUDED.price_per_credit,
             total_credits = EXCLUDED.total_credits,
             url_document = EXCLUDED.url_document
           RETURNING verification_status`,
          [
            cc.rows[0].id,
            req.user.id,
            verCreditsForSale,
            parseFloat(price_per_credit),
            verTotalCredits,
            verification_doc_url || null,
          ],
        );

        const status =
          verificationRes.rows[0]?.verification_status || "pending";
        verificationStatus = status;

        // Always insert into credit_listings first with pending status.
        await pool.query(
          `INSERT INTO credit_listings
             (credit_id, seller_id, credits_for_sale, price_per_credit, status)
            VALUES ($1,$2,$3,$4,'pending')
            ON CONFLICT ON CONSTRAINT unique_seller_id
            DO UPDATE SET
              credit_id = EXCLUDED.credit_id,
              credits_for_sale = EXCLUDED.credits_for_sale,
              price_per_credit = EXCLUDED.price_per_credit,
              status = 'pending'`,
          [
            cc.rows[0].id,
            req.user.id,
            credits_for_sale || net_credits,
            parseFloat(price_per_credit),
          ],
        );
        listingInserted = true;

        // If verification already rejected, remove listing immediately.
        if (status === "rejected") {
          await pool.query(
            "DELETE FROM credit_listings WHERE seller_id = $1",
            [req.user.id],
          );
          listingInserted = false;
        }
      } catch (err) {
        creditInsertError = {
          message: err.message,
          detail: err.detail,
          code: err.code,
          hint: err.hint,
        };
        console.error("credits secondary insert error:", creditInsertError);
      }

      return res.status(201).json({
        ...spRow,
        net_credits_available: net_credits,
        formula:
          "Net Credits = (annual_reduction - leakage) × (1 - buffer%/100)",
        scientific_standard: "IPCC 2006 + 2019 Refinement | GWP-100 AR5",
        credit_insert_error: creditInsertError,
        verification_status: verificationStatus,
        listing_inserted: listingInserted,
      });
    } catch (err) {
      console.error("credits create error:", err.message);
      return res
        .status(500)
        .json({ error: "Failed to create listing", detail: err.message });
    }
  },
);

// ── POST /api/credits/purchase ───────────────────────────────────────────────
// Atomic credit purchase — row-level lock prevents overselling
router.post(
  "/purchase",
  auth,
  [body("project_id").notEmpty(), body("credits").isFloat({ gt: 0 })],
  async (req, res) => {
    if (!vCheck(req, res)) return;
    const { project_id, listing_id, credits } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Lock the seller_projects row
      const proj = await client.query(
        "SELECT * FROM seller_projects WHERE id=$1 AND status='active' FOR UPDATE",
        [project_id],
      );
      if (!proj.rows.length) throw new Error("Project not found or inactive");
      const p = proj.rows[0];
      if (parseFloat(p.credits_available) < parseFloat(credits))
        throw new Error("Insufficient credits available");

      const total = parseFloat(credits) * parseFloat(p.price_per_credit);

      // 2. Insert into carbon_transactions (existing table — keeps UI working)
      await client.query(
        `INSERT INTO carbon_transactions
           (buyer_id, seller_id, project_id, credits_traded, price_per_credit, total_value)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          req.user.id,
          p.user_id,
          project_id,
          parseFloat(credits),
          parseFloat(p.price_per_credit),
          total,
        ],
      );

      // 3. Deduct from seller_projects
      await client.query(
        "UPDATE seller_projects SET credits_available = credits_available - $1 WHERE id = $2",
        [parseFloat(credits), project_id],
      );

      // 4. Also try new credit_transactions table
      if (listing_id) {
        await client
          .query(
            `INSERT INTO credit_transactions (listing_id, buyer_id, credits_bought, total_price)
           VALUES ($1,$2,$3,$4)`,
            [listing_id, req.user.id, parseFloat(credits), total],
          )
          .catch(() => {});
      }

      await client.query("COMMIT");
      return res.json({
        message: "Purchase successful",
        credits_traded: parseFloat(credits),
        total_value: total,
        currency: "USD",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("purchase error:", err.message);
      return res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

// ── GET /api/credits/transaction ─────────────────────────────────────────────
// Returns transaction history for the authenticated user (as buyer or seller)
router.get("/transaction", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ct.*,
              sp.project_name, sp.project_type,
              buyer.organisation_name  AS buyer_name,
              seller.organisation_name AS seller_name
       FROM carbon_transactions ct
       LEFT JOIN seller_projects sp ON sp.id = ct.project_id
       LEFT JOIN users buyer  ON buyer.id  = ct.buyer_id
       LEFT JOIN users seller ON seller.id = ct.seller_id
       WHERE ct.buyer_id = $1 OR ct.seller_id = $1
       ORDER BY ct.trade_date DESC
       LIMIT 200`,
      [req.user.id],
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("transaction fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── GET /api/credits/verification ───────────────────────────────────────────
// Returns verification queue with seller info
router.get("/verification", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.*,
              u.organisation_name, u.country, u.state,
              cl.status AS listing_status
       FROM verification v
       JOIN users u ON u.id = v.seller_id
       LEFT JOIN credit_listings cl ON cl.credit_id = v.credit_id
       ORDER BY v.created_at DESC`,
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("verification fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch verification list" });
  }
});

// ── PATCH /api/credits/verification/:id ─────────────────────────────────────
// Update verification status + reflect in credit_listings
router.patch(
  "/verification/:id",
  auth,
  [body("status").isIn(["pending", "approved", "rejected"])],
  async (req, res) => {
    if (!vCheck(req, res)) return;
    const { status } = req.body;
    try {
      const vRes = await pool.query(
        "SELECT * FROM verification WHERE id = $1",
        [req.params.id],
      );
      if (!vRes.rows.length)
        return res.status(404).json({ error: "Verification not found" });
      const verificationRow = vRes.rows[0];

      await pool.query(
        "UPDATE verification SET verification_status=$1 WHERE id=$2",
        [status, req.params.id],
      );

      let listingAction = "none";
      if (status === "approved") {
        const upRes = await pool.query(
          "UPDATE credit_listings SET status='approved' WHERE credit_id=$1",
          [verificationRow.credit_id],
        );
        if (!upRes.rowCount) {
          await pool.query(
            `INSERT INTO credit_listings
               (credit_id, seller_id, credits_for_sale, price_per_credit, status)
             VALUES ($1,$2,$3,$4,'approved')
             ON CONFLICT ON CONSTRAINT unique_seller_id
             DO UPDATE SET
               credit_id = EXCLUDED.credit_id,
               credits_for_sale = EXCLUDED.credits_for_sale,
               price_per_credit = EXCLUDED.price_per_credit,
               status = 'approved'`,
            [
              verificationRow.credit_id,
              verificationRow.seller_id,
              verificationRow.credits_for_sale,
              verificationRow.price_per_credit,
            ],
          );
          listingAction = "inserted";
        } else {
          listingAction = "updated";
        }
      } else if (status === "pending") {
        const upRes = await pool.query(
          "UPDATE credit_listings SET status='pending' WHERE credit_id=$1",
          [verificationRow.credit_id],
        );
        if (!upRes.rowCount) {
          await pool.query(
            `INSERT INTO credit_listings
               (credit_id, seller_id, credits_for_sale, price_per_credit, status)
             VALUES ($1,$2,$3,$4,'pending')
             ON CONFLICT ON CONSTRAINT unique_seller_id
             DO UPDATE SET
               credit_id = EXCLUDED.credit_id,
               credits_for_sale = EXCLUDED.credits_for_sale,
               price_per_credit = EXCLUDED.price_per_credit,
               status = 'pending'`,
            [
              verificationRow.credit_id,
              verificationRow.seller_id,
              verificationRow.credits_for_sale,
              verificationRow.price_per_credit,
            ],
          );
          listingAction = "inserted";
        } else {
          listingAction = "updated";
        }
      } else if (status === "rejected") {
        await pool.query(
          "DELETE FROM credit_listings WHERE credit_id=$1",
          [verificationRow.credit_id],
        );
        listingAction = "deleted";
      }

      return res.json({
        id: req.params.id,
        verification_status: status,
        listing_action: listingAction,
      });
    } catch (err) {
      console.error("verification update error:", err.message);
      return res
        .status(500)
        .json({ error: "Failed to update verification status" });
    }
  },
);

module.exports = router;

// server.js — Carbon Credit Exchange — Node.js API Gateway
// Hosts all 7 microservices as Express route groups:
//   1. Auth Service          /api/auth
//   2. User Service          /api/users
//   3. Project Service       /api/projects
//   4. Accounting Service    /api/carbon  (proxies → Python FastAPI)
//   5. Transaction Service   /api/credits
//   6. GIS Spatial Service   /api/gis
//   7. Dashboard Service     /api/dashboard
//
// GeoServer streams map tiles DIRECTLY to the frontend — not proxied here.
// Python accounting engine runs on FASTAPI_BASE_URL (default :8000).

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({ origin: process.env.FRONTEND_ORIGIN || "*", credentials: true }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const dashboardLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

app.use("/api/auth/", authLimiter);
app.use("/api/dashboard", dashboardLimiter);
app.use("/api/", limiter);

// ── Serve frontend static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ── 1. Auth Service ──────────────────────────────────────────────────────────
app.use("/api/auth", require("./routes/auth"));

// ── 2. User Management Service ───────────────────────────────────────────────
app.use("/api/users", require("./routes/users"));

// ── 3. Project Management Service ───────────────────────────────────────────
app.use("/api/projects", require("./routes/projects"));

// ── 4. Carbon Accounting Service (proxies to Python FastAPI) ─────────────────
// Keeps existing /api/carbon/* routes (UI depends on them).
app.use("/api/carbon", require("./routes/carbon"));

// ── 5. Transaction + Marketplace Service ────────────────────────────────────
app.use("/api/credits", require("./routes/credits"));

// ── 6. GIS Spatial Service ───────────────────────────────────────────────────
// Returns GeoJSON metadata. Raster tiles served by GeoServer directly.
app.use("/api/gis", require("./routes/gis"));

// ── 7. Dashboard & Analytics Service ────────────────────────────────────────
app.use("/api/dashboard", require("./routes/dashboard"));

// ── Legacy: /api/seller kept for seller_form.html backward-compat ────────────
app.use("/api/seller", require("./routes/seller"));

// ── Frontend page routes (SPA-style) ────────────────────────────────────────
const sendPage = (name) => (req, res) => {
  const p = path.join(__dirname, "..", "frontend", "pages", name);
  const fallback = path.join(__dirname, "..", "frontend", "index.html");
  res.sendFile(fs.existsSync(p) ? p : fallback);
};

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html")),
);
app.get("/dashboard", sendPage("dashboard.html"));
app.get("/register", sendPage("register.html"));
app.get("/login", sendPage("login.html"));
app.get("/buyer", sendPage("buyer_form.html"));
app.get("/seller", sendPage("seller_form.html"));
app.get("/seller-legacy", sendPage("seller.html"));
app.get("/verification", sendPage("verification.html"));
app.get("/marketplace", sendPage("marketplace.html"));
app.get("/projects", sendPage("projects.html")); // new — falls back to index
app.get("/transactions", sendPage("transactions.html")); // new — falls back to index

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log("\n🌍 Carbon Credit Exchange — Node.js API Gateway");
  console.log(`   Running on      http://localhost:${PORT}`);
  console.log(
    `   Python Engine:  ${process.env.FASTAPI_BASE_URL || "http://localhost:8000"}`,
  );
  console.log(
    `   GeoServer:      ${process.env.GEOSERVER_URL || "http://localhost:8080/geoserver"}`,
  );
  console.log("\n   Microservices mounted:");
  console.log("   [1] Auth          /api/auth");
  console.log("   [2] Users         /api/users");
  console.log("   [3] Projects      /api/projects");
  console.log("   [4] Accounting    /api/carbon   → Python :8000");
  console.log("   [5] Transactions  /api/credits");
  console.log("   [6] GIS           /api/gis      → PostGIS");
  console.log("   [7] Dashboard     /api/dashboard\n");
});

process.on("SIGINT", () => {
  console.log("\n⛔ Shutting down gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("❌ Forced shutdown");
    process.exit(1);
  }, 10000);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use! Set PORT= in .env`);
    process.exit(1);
  }
  throw err;
});

// js/api.js — Centralised API client
// All 7 microservice endpoints are defined here.
// UI pages import this file and call api.* methods.
// DO NOT modify UI HTML/CSS — only this JS client was updated.

const API_BASE = ""; // same origin — Node.js serves frontend on :3001

const api = {
  _token: () => localStorage.getItem("token"),

  _headers() {
    const h = { "Content-Type": "application/json" };
    const t = this._token();
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  },

  async _fetch(method, path, body) {
    const opts = { method, headers: this._headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(data.error || "Request failed"), {
        status: res.status,
        data,
      });
    return data;
  },

  // ── 1. AUTH SERVICE ────────────────────────────────────────────────────────
  register: (body) => api._fetch("POST", "/api/auth/register", body),
  login: (body) => api._fetch("POST", "/api/auth/login", body),
  logout: () => api._fetch("POST", "/api/auth/logout"),
  me: () => api._fetch("GET", "/api/auth/me"),

  // ── 2. USER SERVICE ────────────────────────────────────────────────────────
  getUser: (id) => api._fetch("GET", `/api/users/${id}`),
  listUsers: (role) =>
    api._fetch("GET", "/api/users" + (role ? `?role=${role}` : "")),

  // ── 3. PROJECT SERVICE ─────────────────────────────────────────────────────
  createProject: (body) => api._fetch("POST", "/api/projects", body),
  getProject: (id) => api._fetch("GET", `/api/projects/${id}`),
  submitProjectEmission: (id, body) =>
    api._fetch("POST", `/api/projects/${id}/emission`, body),
  getProjectEmission: (id) => api._fetch("GET", `/api/projects/${id}/emission`),
  submitProjectAbsorption: (id, body) =>
    api._fetch("POST", `/api/projects/${id}/absorption`, body),
  getProjectAbsorption: (id) =>
    api._fetch("GET", `/api/projects/${id}/absorption`),

  // ── 4. ACCOUNTING SERVICE (Python engine via Node proxy) ──────────────────
  // Primary buyer emission calculation — existing UI uses this, keep as-is
  calculateEmission: (body) =>
    api._fetch("POST", "/api/carbon/emission/calculate", body),
  // Absorption calculation
  calculateAbsorption: (params) =>
    api._fetch(
      "GET",
      "/api/carbon/absorption/calculate?" + new URLSearchParams(params),
    ),
  calculateAbsorptionPost: (body) =>
    api._fetch("POST", "/api/carbon/absorption/calculate", body),

  // ── 5. TRANSACTION + MARKETPLACE SERVICE ──────────────────────────────────
  // Listings
  getListings: (params) =>
    api._fetch(
      "GET",
      "/api/credits/listing" +
        (params ? "?" + new URLSearchParams(params) : ""),
    ),
  // Credit calculation (Python engine)
  calculateCredits: (params) =>
    api._fetch("GET", "/api/credits/calculate?" + new URLSearchParams(params)),
  // Purchase
  purchaseCredits: (body) => api._fetch("POST", "/api/credits/purchase", body),
  // Create credit listing (seller)
  createCreditListing: (body) => api._fetch("POST", "/api/credits", body),
  // Verification queue (admin)
  getVerifications: () => api._fetch("GET", "/api/credits/verification"),
  updateVerificationStatus: (id, status) =>
    api._fetch("PATCH", `/api/credits/verification/${id}`, { status }),
  // Transaction history
  getTransactions: () => api._fetch("GET", "/api/credits/transaction"),

  // Legacy aliases — existing UI pages call these; keep them working
  marketplace: (params) =>
    api._fetch(
      "GET",
      "/api/carbon/marketplace?" + new URLSearchParams(params || {}),
    ),
  trade: (body) => api._fetch("POST", "/api/carbon/trade", body),

  // ── 6. GIS SPATIAL SERVICE ─────────────────────────────────────────────────
  // GeoJSON metadata endpoints (OpenLayers vector features / popups)
  // NOTE: Map tile layers come directly from GeoServer, NOT from Node.js.
  gisProjects: () => api._fetch("GET", "/api/gis/projects"),
  gisDistricts: (params) =>
    api._fetch(
      "GET",
      "/api/gis/districts" + (params ? "?" + new URLSearchParams(params) : ""),
    ),
  gisEmissionMap: (params) =>
    api._fetch(
      "GET",
      "/api/gis/emission-map" +
        (params ? "?" + new URLSearchParams(params) : ""),
    ),
  gisProjectsMap: () => api._fetch("GET", "/api/gis/projects-map"),
  gisAbsorptionMap: (params) =>
    api._fetch(
      "GET",
      "/api/gis/absorption-map" +
        (params ? "?" + new URLSearchParams(params) : ""),
    ),

  // ── 7. DASHBOARD & ANALYTICS SERVICE ──────────────────────────────────────
  // Yearly trend (line graph) — supports optional country/state/district filter
  dashboardYearly: (params) => {
    const filtered = Object.fromEntries(
      Object.entries(params || {}).filter(([_, v]) => v),
    );
    return api._fetch(
      "GET",
      "/api/dashboard/yearly" +
        (Object.keys(filtered).length
          ? "?" + new URLSearchParams(filtered)
          : ""),
    );
  },
  // Regional aggregation (bar graph) — auto-resolves country→state→district
  dashboardRegional: (params) => {
    const filtered = Object.fromEntries(
      Object.entries(params || {}).filter(([_, v]) => v),
    );
    return api._fetch(
      "GET",
      "/api/dashboard/regional" +
        (Object.keys(filtered).length
          ? "?" + new URLSearchParams(filtered)
          : ""),
    );
  },

  // Legacy dashboard aliases — existing dashboard.html calls these
  dashboardSummary: (params) => {
    const filtered = Object.fromEntries(
      Object.entries(params || {}).filter(([_, v]) => v),
    );
    return api._fetch(
      "GET",
      "/api/carbon/dashboard/summary" +
        (Object.keys(filtered).length
          ? "?" + new URLSearchParams(filtered)
          : ""),
    );
  },
  dashboardRegion: (params) =>
    api._fetch(
      "GET",
      "/api/carbon/dashboard/region?" + new URLSearchParams(params || {}),
    ),
  districts: (params) =>
    api._fetch(
      "GET",
      "/api/carbon/districts?" + new URLSearchParams(params || {}),
    ),

  // ── Legacy Seller aliases (seller_form.html uses /api/projects) ─────
  registerSellerProject: (body) => api._fetch("POST", "/api/projects", body),
  myProjects: () => api._fetch("GET", "/api/projects/:id"),
};

// ── Toast notification utility ────────────────────────────────────────────────
function showToast(message, type = "success") {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove("show"), 3500);
}

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth() {
  if (!localStorage.getItem("token")) {
    window.location.href =
      "/login?redirect=" + encodeURIComponent(location.pathname);
    return false;
  }
  return true;
}

// ── Logout helper ─────────────────────────────────────────────────────────────
function logout() {
  api
    .logout()
    .catch(() => {})
    .finally(() => {
      localStorage.clear();
      window.location.href = "/login";
    });
}

# CarbonCredit_Monitory_exchange_system# 🌍 CarbonX — IPCC Carbon Credit Monitoring & Exchange System

**Standards**: IPCC 2006 Guidelines + 2019 Refinement | GWP-100 AR5 | Tier 1

---

## Architecture

```
Browser (HTML/CSS/JS + Chart.js)
        ↓  HTTP
Node.js (Express — Auth Gateway, Port 3000)
        ↓  axios proxy
FastAPI (Python — Carbon Engine, Port 8000)
        ↓  SQLAlchemy async
PostgreSQL (carbon_db)
```

---

## Project Structure

```
carbon_system/
├── node_auth/                    ← Node.js Auth + API Gateway
│   ├── server.js                 ← Express entry point
│   ├── package.json
│   ├── routes/
│   │   ├── auth.js               ← Register, Login, /me
│   │   ├── carbon.js             ← Proxy to FastAPI + DB save
│   │   └── seller.js             ← Seller project registration
│   ├── middleware/
│   │   ├── auth.js               ← JWT verification
│   │   └── validate.js           ← express-validator handler
│   └── config/
│       ├── db.js                 ← PostgreSQL pool
│       └── env.example           ← Environment variable template
│
├── fastapi_engine/               ← Python IPCC Engine
│   ├── app/
│   │   ├── main.py               ← FastAPI entry point
│   │   ├── core/
│   │   │   ├── ef_registry.py    ← UNCHANGED IPCC EF tables
│   │   │   └── config.py
│   │   ├── services/
│   │   │   ├── aggregation.py    ← GWP-100 AR5 (UNCHANGED)
│   │   │   ├── emission.py       ← 6-sector pipeline (UNCHANGED)
│   │   │   └── absorption.py     ← 7-sink pipeline (UNCHANGED)
│   │   ├── routers/
│   │   │   └── emission.py       ← 4 API endpoints
│   │   └── db/
│   │       └── database.py
│   └── requirements.txt
│
├── frontend/                     ← Vanilla HTML/CSS/JS
│   ├── index.html                ← Landing page
│   ├── css/main.css              ← Full stylesheet
│   ├── js/api.js                 ← Centralised API client
│   └── pages/
│       ├── register.html         ← 2-step registration
│       ├── login.html            ← JWT login
│       ├── dashboard.html        ← Charts + indicators
│       ├── buyer_form.html       ← Scope 1/2/3 declaration
│       ├── seller_form.html      ← Project registration
│       └── marketplace.html      ← Credit trading
│
├── database/
│   └── schema.sql                ← All tables + indexes + views
└── docs/
    └── api_examples.json         ← Request/response examples
```

---

## Setup

### 1. PostgreSQL

<<<<<<< HEAD

=======

> > > > > > > 9b503307fb3435f878ea111635e31561035470aa

```bash
psql -U postgres -c "CREATE DATABASE carbon_db;"
psql -U postgres -d carbon_db -f database/schema.sql
```

### 2. FastAPI Engine

<<<<<<< HEAD

=======

> > > > > > > 9b503307fb3435f878ea111635e31561035470aa

```bash
cd fastapi_engine
pip install -r requirements.txt
cp ../node_auth/config/env.example .env   # set DATABASE_URL
uvicorn app.main:app --reload --port 8000
# Docs: http://localhost:8000/docs
```

### 3. Node.js Gateway

<<<<<<< HEAD

=======

> > > > > > > 9b503307fb3435f878ea111635e31561035470aa

```bash
cd node_auth
npm install
cp config/env.example .env   # set DATABASE_URL, JWT_SECRET, FASTAPI_BASE_URL
node server.js
# App: http://localhost:3000
```

---

## API Endpoints

<<<<<<< HEAD
| Method | Path | Service | Description |
| ------ | -------------------------------- | ------------ | ----------------------- |
| POST | `/api/auth/register` | Node | 2-step org registration |
| POST | `/api/auth/login` | Node | JWT login |
| GET | `/api/auth/me` | Node | Current user |
| POST | `/api/carbon/emission/calculate` | Node→FastAPI | Scope 1/2/3 CO₂e |
| POST | `/api/carbon/seller/calculate` | Node→FastAPI | Net credit calc |
| GET | `/api/carbon/dashboard/summary` | Node→FastAPI | Yearly trend |
| GET | `/api/carbon/dashboard/region` | Node→FastAPI | Regional aggregation |
| GET | `/api/carbon/marketplace` | Node→DB | Credit listings |
| POST | `/api/carbon/trade` | Node→DB | Execute trade (atomic) |
| POST | `/api/seller/project` | Node | Register project |
| GET | `/api/seller/projects` | Node | My projects |
=======
| Method | Path | Service | Description |
|--------|------|---------|-------------|
| POST | `/api/auth/register` | Node | 2-step org registration |
| POST | `/api/auth/login` | Node | JWT login |
| GET | `/api/auth/me` | Node | Current user |
| POST | `/api/carbon/emission/calculate` | Node→FastAPI | Scope 1/2/3 CO₂e |
| POST | `/api/carbon/seller/calculate` | Node→FastAPI | Net credit calc |
| GET | `/api/carbon/dashboard/summary` | Node→FastAPI | Yearly trend |
| GET | `/api/carbon/dashboard/region` | Node→FastAPI | Regional aggregation |
| GET | `/api/carbon/marketplace` | Node→DB | Credit listings |
| POST | `/api/carbon/trade` | Node→DB | Execute trade (atomic) |
| POST | `/api/seller/project` | Node | Register project |
| GET | `/api/seller/projects` | Node | My projects |

> > > > > > > 9b503307fb3435f878ea111635e31561035470aa

---

## Scientific Standards

| Constant     | Value                           | Source                      |
| ------------ | ------------------------------- | --------------------------- |
| GWP CO₂      | 1                               | IPCC AR5 (2013) Table 8.A.1 |
| GWP CH₄      | 28                              | IPCC AR5 (2013) Table 8.A.1 |
| GWP N₂O      | 265                             | IPCC AR5 (2013) Table 8.A.1 |
| GWP HFC-134a | 1300                            | IPCC AR5 (2013) Table 8.A.1 |
| GWP SF₆      | 23500                           | IPCC AR5 (2013) Table 8.A.1 |
| Aggregation  | CO₂e = Σ(gas × GWP)             | Gas-wise BEFORE GWP         |
| Unit         | t CO₂e                          | Tonne CO₂ equivalent        |
| Methodology  | Tier 1                          | Activity × Emission Factor  |
| Absorption   | CO₂ only                        | GWP_CO₂ = 1 (biological)    |
| Net Credits  | (reduction−leakage)×(1−buffer%) | Seller formula              |

**References**: IPCC 2006 Guidelines Vol.2/3/4 | 2019 Refinement | AR5 GWP-100

---

## Database Index Strategy

<<<<<<< HEAD
| Index | Type | Query Optimised |
| --------------------------------------------- | ------------- | ------------------------- |
| `emission_records(buyer_id, year)` | Clustered | Historical emission trend |
| `emission_records(year)` | Non-clustered | Dashboard year filter |
| `seller_projects(project_type)` | Non-clustered | Marketplace type filter |
| `seller_projects(price_per_credit)` | Non-clustered | Price range filter |
| `seller_projects(vintage_start, vintage_end)` | Non-clustered | Vintage filter |
| `carbon_transactions(trade_date DESC)` | Clustered | Temporal dashboard |
| `users(country, state, district)` | Composite | Regional aggregation |

# Carbon-Credit-Monitory-ExchangeSystem

=======
| Index | Type | Query Optimised |
|---|---|---|
| `emission_records(buyer_id, year)` | Clustered | Historical emission trend |
| `emission_records(year)` | Non-clustered | Dashboard year filter |
| `seller_projects(project_type)` | Non-clustered | Marketplace type filter |
| `seller_projects(price_per_credit)` | Non-clustered | Price range filter |
| `seller_projects(vintage_start, vintage_end)` | Non-clustered | Vintage filter |
| `carbon_transactions(trade_date DESC)` | Clustered | Temporal dashboard |
| `users(country, state, district)` | Composite | Regional aggregation |

> > > > > > > 9b503307fb3435f878ea111635e31561035470aa

**PREVIEW**

<img width="1677" height="1491" alt="localhost_3001_dashboard" src="https://github.com/user-attachments/assets/6bd6c347-5f25-41b4-8ee5-8d59e933c2f0" />

<img width="1154" height="621" alt="Screenshot 2026-04-16 092845" src="https://github.com/user-attachments/assets/70a808f9-54de-4de4-be55-494406df9eb3" />

<img width="1154" height="630" alt="Screenshot 2026-04-16 092925" src="https://github.com/user-attachments/assets/33116453-aa53-4d75-ad55-6c081102d36c" />




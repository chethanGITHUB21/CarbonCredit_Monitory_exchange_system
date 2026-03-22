import requests
import random
import time
import uuid

BASE_URL = "http://localhost:3001"

REGISTER_URL  = f"{BASE_URL}/api/auth/register"
LOGIN_URL     = f"{BASE_URL}/api/auth/login"
PROJECTS_URL  = f"{BASE_URL}/api/projects"
CREDITS_URL   = f"{BASE_URL}/api/credits"

headers = {"Content-Type": "application/json"}

# ─────────────────────────────────────────────
# CONFIGURATION — change these to control scale
# ─────────────────────────────────────────────
NUM_SELLERS         = 3     # ← change this to register more/fewer sellers
ABSORPTIONS_PER_SELLER = 1  # ← absorption submissions per seller

MIN_DELAY       = 4
MAX_DELAY       = 7
COOLDOWN_ON_429 = 60

# ─────────────────────────────────────────────
# STATIC DATA
# ─────────────────────────────────────────────

TAMIL_NADU_DISTRICTS = [
    "Ariyalur", "Chengalpattu", "Chennai", "Coimbatore", "Cuddalore",
    "Dharmapuri", "Dindigul", "Erode", "Kallakurichi", "Kanchipuram",
    "Kanyakumari", "Karur", "Krishnagiri", "Madurai", "Mayiladuthurai",
    "Nagapattinam", "Namakkal", "Nilgiris", "Perambalur", "Pudukkottai",
    "Ramanathapuram", "Ranipet", "Salem", "Sivaganga", "Tenkasi",
    "Thanjavur", "Theni", "Thoothukudi", "Tiruchirappalli", "Tirunelveli",
    "Tirupathur", "Tiruppur", "Tiruvallur", "Tiruvannamalai", "Tiruvarur",
    "Vellore", "Villupuram", "Virudhunagar"
]

ORGANISATION_TYPES = [
    "Manufacturing", "Energy", "Agriculture", "Transportation",
    "Healthcare", "Government", "NGO / Non-profit", "Research Institution"
]

PROJECT_TYPES = [
    "wetland",
    "forest",
    "trees",
    "carbon_sink_tech",
    "coastal",
    "eco_park",
    "river",
]

METHODOLOGIES = [
    "VCS VM0007",
    "Gold Standard GS4GG",
    "CDM ACM0010",
    "Verra VM0033",
    "Gold Standard V2",
]

PROJECT_NAME_PREFIXES = [
    "Sundarbans",
    "Western Ghats",
    "Nilgiri",
    "Pichavaram",
    "Kodaikanal",
    "Anamalai",
    "Mudumalai",
    "Cauvery",
    "Palani Hills",
    "Kolli Hills",
]

PROJECT_NAME_SUFFIXES = [
    "Wetland Restoration",
    "Forest Conservation",
    "Urban Tree Corridor",
    "Carbon Sink Pilot",
    "Reforestation Drive",
    "Ecosystem Recovery",
    "Green Belt Initiative",
    "Blue Carbon Reserve",
]

BOUNDARIES = [
    "South 24 Parganas", "Nilgiris District", "Coimbatore Zone",
    "Salem Forest Division", "Thanjavur Delta", "Tirunelveli South",
    "Madurai East", "Erode North", "Vellore Hills", "Kanyakumari Coast"
]

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────

def rate_limit():
    delay = random.uniform(MIN_DELAY, MAX_DELAY)
    print(f"  Waiting {delay:.1f}s...")
    time.sleep(delay)


def safe_post(url, payload, hdrs):
    while True:
        try:
            r = requests.post(url, json=payload, headers=hdrs)
            if r.status_code == 429:
                print("  Rate limit hit — cooling down 60s...")
                time.sleep(COOLDOWN_ON_429)
                continue
            return r
        except requests.exceptions.ConnectionError:
            print("  Connection error — retrying in 10s...")
            time.sleep(10)


def safe_get(url, hdrs):
    try:
        r = requests.get(url, headers=hdrs)
        return r
    except requests.exceptions.ConnectionError:
        print("  Connection error on GET")
        return None

# ─────────────────────────────────────────────
# STEP 1 — REGISTER SELLER
# ─────────────────────────────────────────────

def register_seller(state, district):
    email = f"seller_{uuid.uuid4().hex[:8]}@gmail.com"
    org_type = random.choice(ORGANISATION_TYPES)

    payload = {
        "organisation_type": org_type,
        "organisation_name": f"{org_type} {state} {random.randint(1, 999)}",
        "country":  "India",
        "state":    state,
        "district": district,
        "zone":     str(random.randint(1, 10)),
        "ward":     str(random.randint(1, 50)),
        "email":    email,
        "password": "SecurePass@123",
        "role":     "seller"
    }

    r = safe_post(REGISTER_URL, payload, headers)
    rate_limit()

    if r.status_code in [200, 201]:
        print(f"  ✓ Registered seller: {email} [{district}, {state}]")
        return email
    else:
        print(f"  ✗ Registration failed: {r.status_code} — {r.text[:120]}")
        return None

# ─────────────────────────────────────────────
# STEP 2 — LOGIN
# ─────────────────────────────────────────────

def login_user(email):
    payload = {"email": email, "password": "SecurePass@123"}
    r = safe_post(LOGIN_URL, payload, headers)
    rate_limit()

    if r.status_code == 200:
        token = r.json().get("token")
        print(f"  ✓ Login: {email}")
        return token

    print(f"  ✗ Login failed: {r.text[:120]}")
    return None

# ─────────────────────────────────────────────
# STEP 3a — POST /api/projects
# ─────────────────────────────────────────────

def create_project(token, state_id, district_id):
    name = f"{random.choice(PROJECT_NAME_PREFIXES)} {random.choice(PROJECT_NAME_SUFFIXES)}"
    p_type = random.choice(PROJECT_TYPES)

    payload = {
        "project_name": name,
        "project_type": p_type,
        "description":  f"Community-led {p_type} initiative in Tamil Nadu",
        "country_id":   1,
        "state_id":     state_id,
        "district_id":  district_id,
        "latitude":     round(random.uniform(8.0, 13.5), 4),
        "longitude":    round(random.uniform(76.5, 80.5), 4)
    }

    auth_hdrs = {**headers, "Authorization": f"Bearer {token}"}
    r = safe_post(PROJECTS_URL, payload, auth_hdrs)
    rate_limit()

    if r.status_code in [200, 201]:
        project_id = r.json().get("id") or r.json().get("project", {}).get("id")
        print(f"  ✓ Project created: {name} (id: {project_id})")
        return project_id, name, p_type
    else:
        print(f"  ✗ Project creation failed: {r.status_code} — {r.text[:120]}")
        return None, name, p_type

# ─────────────────────────────────────────────
# STEP 3b — POST /api/projects/:id/absorption
# ─────────────────────────────────────────────

def submit_absorption(token, project_id):
    year = random.choice([2022, 2023, 2024, 2025, 2026])

    # Versatile absorption — each submission is different
    payload = {
        "wetland":          {"area_m2": random.randint(50000, 500000)},
        "forest":           {"area_m2": random.randint(500000, 5000000)},
        "trees":            {"number_of_trees": random.randint(500, 20000)},
        "carbon_sink_tech": {"co2_captured_tonnes_per_year": round(random.uniform(20, 300), 2)},
        "coastal":          {"area_m2": random.randint(20000, 200000)},
        "eco_park":         {"area_m2": random.randint(10000, 100000)},
        "river":            {"area_m2": random.randint(30000, 300000)},

        # Flat fields (fallback format your backend also accepts)
        "area_m2":               random.randint(500000, 5000000),
        "tree_count":            random.randint(500, 20000),
        "other_absorption_co2e": round(random.uniform(10, 200), 2),

        "year": year
    }

    url = f"{PROJECTS_URL}/{project_id}/absorption"
    auth_hdrs = {**headers, "Authorization": f"Bearer {token}"}
    r = safe_post(url, payload, auth_hdrs)
    rate_limit()

    if r.status_code in [200, 201]:
        print(f"  ✓ Absorption submitted for project {project_id} (year {year})")
    else:
        print(f"  ✗ Absorption failed: {r.status_code} — {r.text[:120]}")

# ─────────────────────────────────────────────
# STEP 3c — POST /api/credits
# ─────────────────────────────────────────────

def submit_credits(token, project_name, project_type, district):
    baseline   = random.randint(20000, 100000)
    reduction  = random.randint(5000, int(baseline * 0.6))
    leakage    = round(reduction * random.uniform(0.05, 0.15), 2)
    vintage    = random.choice([2022, 2023, 2024])

    payload = {
        "project_name":         project_name,
        "project_type":         project_type,
        "methodology":          random.choice(METHODOLOGIES),
        "baseline_emission":    baseline,
        "annual_reduction":     reduction,
        "leakage":              leakage,
        "buffer_percent":       random.choice([10, 15, 20]),
        "price_per_credit":     round(random.uniform(5.0, 25.0), 2),
        "vintage_start":        vintage,
        "vintage_end":          vintage + random.randint(1, 3),
        "project_boundary":     district,
        "verification_doc_url": f"https://example.com/docs/{uuid.uuid4().hex[:8]}.pdf"
    }

    auth_hdrs = {**headers, "Authorization": f"Bearer {token}"}
    r = safe_post(CREDITS_URL, payload, auth_hdrs)
    rate_limit()

    if r.status_code in [200, 201]:
        print(f"  ✓ Credits listed: {reduction} credits @ ₹{payload['price_per_credit']}/credit")
    else:
        print(f"  ✗ Credits failed: {r.status_code} — {r.text[:120]}")

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    print(f"\n{'='*55}")
    print(f"  CarbonLedger — Seller Absorption Data Generation")
    print(f"  Sellers to register : {NUM_SELLERS}")
    print(f"  Absorptions/seller  : {ABSORPTIONS_PER_SELLER}")
    print(f"{'='*55}\n")

    success = 0

    for i in range(NUM_SELLERS):
        print(f"\n[Seller {i+1}/{NUM_SELLERS}]")

        district = random.choice(TAMIL_NADU_DISTRICTS)
        state    = "Tamil Nadu"

        # Use district index as a proxy for district_id
        # Replace with real IDs if your DB is populated
        district_id = TAMIL_NADU_DISTRICTS.index(district) + 1
        state_id    = 1   # Tamil Nadu = 1 in your states table

        # 1. Register
        email = register_seller(state, district)
        if not email:
            continue

        # 2. Login
        token = login_user(email)
        if not token:
            continue

        # 3. Create project + submit absorption + list credits
        for j in range(ABSORPTIONS_PER_SELLER):
            print(f"  [Submission {j+1}/{ABSORPTIONS_PER_SELLER}]")

            project_id, project_name, project_type = create_project(
                token, state_id, district_id
            )

            if not project_id:
                print("  Skipping absorption+credits (no project id)")
                continue

            submit_absorption(token, project_id)
            submit_credits(token, project_name, project_type, district)

            time.sleep(random.uniform(5, 9))

        success += 1
        time.sleep(random.uniform(6, 10))

    print(f"\n{'='*55}")
    print(f"  Done. {success}/{NUM_SELLERS} sellers completed.")
    print(f"{'='*55}\n")


if __name__ == "__main__":
    main()

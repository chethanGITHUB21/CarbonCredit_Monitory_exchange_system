// ============================================================
// index.js — OpenLayers Map + GeoServer WMS Integration
// Data source: emission_records table via vw_district_emission view
// Columns used: co2_norm, ch4_norm, n2o_norm, total_norm, absorption_norm
// ============================================================

// ── 1. Base OSM Layer ────────────────────────────────────────

const osmLayer = new ol.layer.Tile({
  source: new ol.source.OSM(),
});

// ── 2. WMS Emission Layer ────────────────────────────────────
// GeoServer serves vw_district_emission view.
// Default style: co2_emission (colours by gas_co2 from emission_records)
const wmsSource = new ol.source.ImageWMS({
  url: "http://localhost:8080/geoserver/wms",
  params: {
    LAYERS: "carbonGEO:vw_district_emission",
    STYLES: "gas_co2",
    CQL_FILTER: "INCLUDE",
  },
  serverType: "geoserver",
  crossOrigin: "anonymous",
});

// creating tile for LEGEND layer display
const emissionLayer = new ol.layer.Tile({
  source: new ol.source.TileWMS({
    url: "http://localhost:8080/geoserver/wms",
    params: {
      LAYERS: "carbonGEO:vw_district_emission",
      STYLES: [
        "gas_co2",
        "gas_ch4",
        "n2o_norm",
        "total_norm",
        "total_co2e",
        "absorption_norm",
      ],
      TILED: true,
    },
    serverType: "geoserver",
  }),
});

// Extra layers: factory emitters + eco-project absorbers (toggle via buttons)
const emitterSource = new ol.source.ImageWMS({
  url: "http://localhost:8080/geoserver/wms",
  params: {
    LAYERS: "carbonGEO:emitter_table",
    CQL_FILTER: "INCLUDE",
  },
  serverType: "geoserver",
  crossOrigin: "anonymous",
});

const absorberSource = new ol.source.ImageWMS({
  url: "http://localhost:8080/geoserver/wms",
  params: {
    LAYERS: "carbonGEO:eco_projects_table",
    CQL_FILTER: "INCLUDE",
  },
  serverType: "geoserver",
  crossOrigin: "anonymous",
});

const wmsLayer = new ol.layer.Image({ source: wmsSource });
const emitterLayer = new ol.layer.Image({
  source: emitterSource,
  visible: false,
});
const absorberLayer = new ol.layer.Image({
  source: absorberSource,
  visible: false,
});
// ── 3. Map Init ───────────────────────────────────────────────
const map = new ol.Map({
  target: "map",
  layers: [osmLayer, wmsLayer, emitterLayer, absorberLayer],
  view: new ol.View({
    center: ol.proj.fromLonLat([78.9629, 20.5937]),
    zoom: 4,
  }),
});
map.addLayer(emissionLayer);

// Toggle extra project layers
window.showProjectLayer = function (type) {
  const showEmitter = type === "emitter";
  const showAbsorber = type === "absorber";

  emitterLayer.setVisible(showEmitter);
  absorberLayer.setVisible(showAbsorber);

  applyMapFilters();
};

// ── 4. Highlight Layer (district click outline) ───────────────
const highlightSource = new ol.source.Vector();
const highlightLayer = new ol.layer.Vector({
  source: highlightSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#1a6b3c", width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(196, 186, 186, 0.58)" }),
  }),
});
map.addLayer(highlightLayer);

// ── 5. State: what gas + what region filter is active ─────────
// NEW — matches exactly what vw_district_emission has
const emissionFieldByStyle = {
  gas_co2: "gas_co2",
  total_co2e: "total_co2e", // total_co2e
  gas_ch4: "gas_ch4",
  n2o_norm: "n2o_norm", // N2O mapped to thermal button
  total_norm: "total_norm", // total_co2e mapped to vehicle button
  absorption_norm: "absorption_norm", // total_absorption
};

let selectedStyle = "co2_emission"; // current emission type button
let regionCQL = ""; // CQL from dashboard Country/State/District
let levelCQL = ""; // CQL from Low/Medium/High buttons

// ── 6. Build & apply combined CQL filter ─────────────────────
// Combines region filter from dashboard + level filter from buttons.
// GeoServer receives a single CQL_FILTER string.
function applyMapFilters() {
  const parts = [];
  if (regionCQL) parts.push(regionCQL);
  if (levelCQL) parts.push(levelCQL);
  const combined = parts.length > 0 ? parts.join(" AND ") : "INCLUDE";

  wmsSource.updateParams({
    STYLES: selectedStyle,
    CQL_FILTER: combined,
    _refresh: Date.now(),
  });

  const regionOnly = regionCQL || "INCLUDE";
  emitterSource.updateParams({ CQL_FILTER: regionOnly, _refresh: Date.now() });
  absorberSource.updateParams({ CQL_FILTER: regionOnly, _refresh: Date.now() });
}

// ── 7. Emission Type Buttons (CO2 / CH4 / CO2e / N2O / Forest) ──
window.changeEmission = function (styleLayer) {
  selectedStyle = styleLayer;
  // When emission type changes, clear the level filter
  // (level is relative to the selected gas so reset is correct)
  levelCQL = "";
  applyMapFilters();
  updateLegend();
};

function updateLegend() {
  const style = wmsSource.getParams().STYLES || "";
  const legendUrl =
    "http://localhost:8080/geoserver/wms" +
    "?REQUEST=GetLegendGraphic" +
    "&VERSION=1.0.0" +
    "&FORMAT=image/png" +
    "&LAYER=carbonGEO:vw_district_emission" +
    (style ? `&STYLE=${encodeURIComponent(style)}` : "") +
    "&TRANSPARENT=true";
  const img = document.getElementById("legend-img");
  if (img) img.src = legendUrl;
}

updateLegend();

// ── 8. Level Buttons (Low / Medium / High) ────────────────────
window.changeLevel = function (level) {
  const field = emissionFieldByStyle[selectedStyle] || "co2_norm";

  if (level === "low") {
    levelCQL = `${field} >= 0 AND ${field} < 0.33`;
  } else if (level === "medium") {
    levelCQL = `${field} >= 0.33 AND ${field} < 0.66`;
  } else if (level === "high") {
    levelCQL = `${field} >= 0.66 AND ${field} <= 1.0`;
  }
  applyMapFilters();
};

window.resetLevel = function () {
  levelCQL = "";
  applyMapFilters();
};

// ── 9. Dashboard Filter Integration ──────────────────────────
// Called from dashboard.html loadDashboard() when Apply is clicked.
// Converts Country / State / District dropdown values into CQL_FILTER
// so the GeoServer emission map highlights only the selected region.
//
// CQL property names match vw_district_emission columns:
//   country, state, district (all VARCHAR, case-insensitive match via strToLowerCase)
function cqlSafe(value) {
  return String(value).replace(/'/g, "''");
}

window.updateMapRegionFilter = function (country, state, district) {
  const parts = [];

  if (country && country.trim()) {
    parts.push(
      `strToLowerCase(country) = '${cqlSafe(country.trim().toLowerCase())}'`,
    );
  }
  if (state && state.trim()) {
    parts.push(
      `strToLowerCase(state) = '${cqlSafe(state.trim().toLowerCase())}'`,
    );
  }
  if (district && district.trim()) {
    parts.push(
      `strToLowerCase(district) = '${cqlSafe(district.trim().toLowerCase())}'`,
    );
  }

  regionCQL = parts.length > 0 ? parts.join(" AND ") : "";

  // Auto-zoom map to the filtered region
  if (district && district.trim()) {
    zoomToRegion("district", district.trim());
  } else if (state && state.trim()) {
    zoomToRegion("state", state.trim());
  } else if (country && country.trim()) {
    zoomToRegion("country", country.trim());
  } else {
    // Reset to India view
    map.getView().animate({
      center: ol.proj.fromLonLat([78.9629, 20.5937]),
      zoom: 4,
      duration: 800,
    });
  }

  applyMapFilters();
};

// ── 10. Auto-zoom to WFS extent of filtered region ───────────
function zoomToRegion(level, name) {
  const fieldMap = { district: "district", state: "state", country: "country" };
  const field = fieldMap[level];
  // For district: 1 feature is enough. For state/country: fetch all districts to get full bbox.
  const maxFeatures = level === "district" ? 1 : 500;

  const cql = `strToLowerCase(${field})='${cqlSafe(name.toLowerCase())}'`;
  const wfsUrl =
    `http://localhost:8080/geoserver/carbonGEO/ows?` +
    `service=WFS&version=1.0.0&request=GetFeature&` +
    `typeName=carbonGEO:vw_district_emission&` +
    `outputFormat=application/json&` +
    `CQL_FILTER=${encodeURIComponent(cql)}&` +
    `maxFeatures=${maxFeatures}`;

  fetch(wfsUrl)
    .then((r) => r.json())
    .then((data) => {
      if (!data.features || !data.features.length) return;

      const format = new ol.format.GeoJSON();
      const features = format.readFeatures(data, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      if (!features.length) return;

      // Union all feature extents into one bounding box
      const extent = ol.extent.createEmpty();
      features.forEach((f) => {
        const geom = f.getGeometry();
        if (geom) ol.extent.extend(extent, geom.getExtent());
      });

      if (ol.extent.isEmpty(extent)) return;

      map.getView().fit(extent, {
        duration: 900,
        padding: [50, 50, 50, 50],
        maxZoom: level === "district" ? 10 : level === "state" ? 7 : 5,
      });
    })
    .catch(() => {}); // silent — zoom failure is non-critical
}

// ── 11. Click Popup — GetFeatureInfo + WFS detail ─────────────
function classifyValue(value) {
  if (value === null || value === undefined) return "No data";
  if (value < 0.33) return `Low (${value.toFixed(3)})`;
  if (value < 0.66) return `Medium (${value.toFixed(3)})`;
  return `High (${value.toFixed(3)})`;
}

map.on("singleclick", function (evt) {
  const viewRes = map.getView().getResolution();

  // GetFeatureInfo to get properties at click point
  const infoUrl = wmsSource.getFeatureInfoUrl(
    evt.coordinate,
    viewRes,
    "EPSG:3857",
    { INFO_FORMAT: "application/json" },
  );

  if (!infoUrl) return;

  const emitterVisible = emitterLayer.getVisible();
  const absorberVisible = absorberLayer.getVisible();

  const emitterInfoUrl = emitterVisible
    ? emitterSource.getFeatureInfoUrl(evt.coordinate, viewRes, "EPSG:3857", {
        INFO_FORMAT: "application/json",
      })
    : null;

  const absorberInfoUrl = absorberVisible
    ? absorberSource.getFeatureInfoUrl(evt.coordinate, viewRes, "EPSG:3857", {
        INFO_FORMAT: "application/json",
      })
    : null;

  const infoPanel = document.getElementById("info-panel");

  const fetchJson = (url) =>
    url
      ? fetch(url)
          .then((r) => r.json())
          .catch(() => null)
      : Promise.resolve(null);

  Promise.all([
    fetchJson(infoUrl),
    fetchJson(emitterInfoUrl),
    fetchJson(absorberInfoUrl),
  ])
    .then(([emissionData, emitterData, absorberData]) => {
      const emissionFeat =
        emissionData && emissionData.features && emissionData.features[0]
          ? emissionData.features[0]
          : null;
      const emitterFeat =
        emitterData && emitterData.features && emitterData.features[0]
          ? emitterData.features[0]
          : null;
      const absorberFeat =
        absorberData && absorberData.features && absorberData.features[0]
          ? absorberData.features[0]
          : null;

      if (emissionFeat) {
        const props = emissionFeat.properties || {};
        const coord = ol.proj.toLonLat(evt.coordinate);

        // Fetch WFS to highlight the district boundary
        const wfsUrl =
          `http://localhost:8080/geoserver/carbonGEO/ows?` +
          `service=WFS&version=1.0.0&request=GetFeature&` +
          `typeName=carbonGEO:vw_district_emission&` +
          `outputFormat=application/json&` +
          `CQL_FILTER=INTERSECTS(geom,POINT(${coord[0]} ${coord[1]}))`;

        fetch(wfsUrl)
          .then((r) => r.json())
          .then((wfsData) => {
            highlightSource.clear();
            const features = new ol.format.GeoJSON().readFeatures(wfsData, {
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            });
            highlightSource.addFeatures(features);
          })
          .catch(() => {});

        // Build popup table for emission layer
        const gasRows = [
          ["CO₂ (gas_co2)", props.co2_total, props.co2_norm],
          ["CH₄ (gas_ch4)", props.ch4_total, props.ch4_norm],
          ["N₂O (gas_n2o)", props.n2o_total, props.n2o_norm],
          ["Total CO₂e", props.total_co2e, props.total_norm],
          ["Absorption", props.absorption_total, props.absorption_norm],
          ["Net Balance", props.net_balance_total, null],
        ];

        let html = `
          <h3 style="margin:0 0 8px;color:#1a6b3c">
            📍 ${props.district || "—"}, ${props.state || "—"}
          </h3>
          <div style="font-size:0.78rem;color:#666;margin-bottom:8px">
            Year: ${props.year || "—"} &nbsp;|&nbsp; 
            Organisations: ${props.num_organisations || 0}
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:0.8rem">
            <tr style="background:#f0f4f0">
              <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #ddd">Gas</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid #ddd">t CO₂e</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid #ddd">Level</th>
            </tr>
        `;

        for (const [label, total, norm] of gasRows) {
          const totalStr = total != null ? Number(total).toFixed(2) : "—";
          const levelStr = norm != null ? classifyValue(Number(norm)) : "—";
          html += `
            <tr>
              <td style="padding:4px 8px;border-bottom:1px solid #eee">${label}</td>
              <td style="padding:4px 8px;text-align:right;border-bottom:1px solid #eee">${totalStr}</td>
              <td style="padding:4px 8px;text-align:right;border-bottom:1px solid #eee">${levelStr}</td>
            </tr>
          `;
        }

        html += `</table>`;
        infoPanel.innerHTML = html;
        return;
      }

      if (emitterFeat) {
        const props = emitterFeat.properties || {};
        const rows = Object.keys(props).map((k) => {
          const v = props[k];
          return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${k}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${v}</td></tr>`;
        });
        infoPanel.innerHTML = `
          <h3 style="margin:0 0 8px;color:#1a6b3c">🏭 Emitter Factory</h3>
          <table style="width:100%;border-collapse:collapse;font-size:0.8rem">
            <tr style="background:#f0f4f0">
              <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #ddd">Property</th>
              <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #ddd">Value</th>
            </tr>
            ${rows.join("")}
          </table>`;
        return;
      }

      if (absorberFeat) {
        const props = absorberFeat.properties || {};
        const rows = Object.keys(props).map((k) => {
          const v = props[k];
          return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${k}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${v}</td></tr>`;
        });
        infoPanel.innerHTML = `
          <h3 style="margin:0 0 8px;color:#1a6b3c">🌿 Eco Project</h3>
          <table style="width:100%;border-collapse:collapse;font-size:0.8rem">
            <tr style="background:#f0f4f0">
              <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #ddd">Property</th>
              <th style="padding:5px 8px;text-align:left;border-bottom:1px solid #ddd">Value</th>
            </tr>
            ${rows.join("")}
          </table>`;
        return;
      }

      infoPanel.innerHTML =
        "<p style='color:#999;padding:8px'>Click on a district or project point to see details</p>";
    })
    .catch(() => {});
});

// ── 12. Auto Refresh every 30s (reduced from 5s to reduce load) ──
setInterval(() => {
  wmsSource.updateParams({ _refresh: Date.now() });
}, 30000);

// ── 13. Time Slider ───────────────────────────────────────────
// Filters vw_district_emission by year column
const yearValues = [2020, 2021, 2022, 2023, 2024, 2025];
const slider = document.getElementById("timeSlider");

if (slider) {
  slider.addEventListener("input", function (e) {
    const year = yearValues[parseInt(e.target.value)] || 2024;
    // Add year to the region filter
    const yearPart = `year = ${year}`;
    const parts = [];
    if (regionCQL) parts.push(regionCQL);
    parts.push(yearPart);
    if (levelCQL) parts.push(levelCQL);
    wmsSource.updateParams({
      CQL_FILTER: parts.join(" AND "),
      _refresh: Date.now(),
    });
  });
}

// ── 14. NDJSON Stream Layer (real-time project points) ───────
const vectorSource = new ol.source.Vector();
const vectorLayer = new ol.layer.Vector({
  source: vectorSource,
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5,
      fill: new ol.style.Fill({ color: "#1a9850" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 1 }),
    }),
  }),
});
map.addLayer(vectorLayer);

function startStream() {
  fetch("/stream")
    .then((res) => {
      if (!res.ok || !res.body) return;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function pump() {
        return reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              if (buffer.trim()) tryAddFeature(buffer);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n");
            buffer = parts.pop();
            for (const line of parts) {
              if (line.trim()) tryAddFeature(line);
            }
            return pump();
          })
          .catch((err) => console.error("Stream read error", err));
      }
      pump();
    })
    .catch(() => {});
}

function tryAddFeature(line) {
  const t = (line || "").trim();
  if (!t || t[0] !== "{") return;
  try {
    const feat = JSON.parse(t);
    if (!feat || !feat.geometry) return;
    const olFeat = new ol.format.GeoJSON().readFeature(feat, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    vectorSource.addFeature(olFeat);
  } catch (e) {}
}

startStream();

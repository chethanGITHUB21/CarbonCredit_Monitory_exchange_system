// form-map.js — lightweight OpenLayers map for buyer/seller form pages
const formMap = new ol.Map({
  target: "map",
  layers: [
    new ol.layer.Tile({
      source: new ol.source.OSM(),
    }),
  ],
  view: new ol.View({
    center: ol.proj.fromLonLat([78.9629, 20.5937]),
    zoom: 4,
  }),
});

const crossStyle = new ol.style.Style({
  image: new ol.style.RegularShape({
    points: 4,
    radius: 12,
    angle: Math.PI / 4,
    fill: new ol.style.Fill({ color: "#000" }),
    stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
  }),
});

const selectedFeature = new ol.Feature();
const vectorSource = new ol.source.Vector({ features: [selectedFeature] });
const vectorLayer = new ol.layer.Vector({
  source: vectorSource,
  style: crossStyle,
});

formMap.addLayer(vectorLayer);
formMap.getViewport().style.cursor = "crosshair";

function setFormCoordinates(longitude, latitude) {
  document.querySelectorAll('input[name="longitude"]').forEach((input) => {
    input.value = longitude;
  });
  document.querySelectorAll('input[name="latitude"]').forEach((input) => {
    input.value = latitude;
  });
  const coordLabel = document.getElementById("formCoords");
  if (coordLabel) {
    coordLabel.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  }
}

formMap.on("singleclick", (evt) => {
  const coordinate = evt.coordinate;
  const [lon, lat] = ol.proj.toLonLat(coordinate);
  selectedFeature.setGeometry(new ol.geom.Point(coordinate));
  setFormCoordinates(lon, lat);
});

window.addEventListener("resize", () => {
  formMap.updateSize();
});

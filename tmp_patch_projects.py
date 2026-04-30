from pathlib import Path

path = Path('node_auth/routes/projects.js')
text = path.read_text(encoding='utf-8')

old = '''          [
            longitude,
            latitude,
            buyerName,
            null,
            0,
            gwt.CO2 || 0,
            gwt.CH4 || 0,
            0,
            0,
            calcData.total_emission_co2e || 0,
            districtName,
          ],'''
new = '''          [
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
            districtName,
          ],'''
text = text.replace(old, new)
count = text.count(new)
print('patched emitter occurrences:', count)

old_eco = '''    if (Number.isFinite(projectLatitude) && Number.isFinite(projectLongitude)) {
      await pool.query(
        `INSERT INTO eco_projects
           (geom, name, co2capture, hectares, district_id, District_name)
         VALUES (
           ST_SetSRID(ST_MakePoint($1,$2),4326),
           $3, $4, $5, $6, $7
         )`,
        [
          projectLongitude,
          projectLatitude,
          projectName,
          absorbedValue,
          areaHectares,
          projectDistrictId,
          null,
        ],
      );
    }
'''
new_eco = '''    if (Number.isFinite(projectLatitude) && Number.isFinite(projectLongitude)) {
      try {
        await pool.query(
          `INSERT INTO eco_projects
             (geom, name, co2capture, hectares, district_id, District_name)
           VALUES (
             ST_SetSRID(ST_MakePoint($1,$2),4326),
             $3, $4, $5, $6, $7
           )`,
          [
            projectLongitude,
            projectLatitude,
            projectName,
            absorbedValue,
            areaHectares,
            projectDistrictId,
            null,
          ],
        );
      } catch (insertErr) {
        console.error(
          "eco_projects insert failed",
          insertErr.message,
          insertErr.stack,
          {
            project_id,
            projectLatitude,
            projectLongitude,
            projectName,
            co2capture: absorbedValue,
            hectares: areaHectares,
            district_id: projectDistrictId,
          },
        );
      }
    }
'''
if old_eco in text:
    text = text.replace(old_eco, new_eco)
    print('patched eco_projects block')
else:
    print('eco_projects block not found or already patched')

path.write_text(text, encoding='utf-8')

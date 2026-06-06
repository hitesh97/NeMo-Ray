import { filterSitefinderPayload, parseSitefinderCsv } from '../lib/data/sitefinder';

const CSV = `Operator,Opref,Sitengr,Antennaht,Transtype,Freqband,Powerdbw,Maxpwrdbw,Maxpwrdbm,Sitelat,Sitelng
Orange,ATN0051,TQ3225075840,20,GSM,1800,27.6,32,,51.46557,-0.095904
Orange,ATN0051,TQ3225075840,21,UMTS,2100,25.7,,65,51.46557,-0.095904
Vodafone,VF001,TQ0000000000,not-a-number,NR,3500,,,,51.5,-0.1
Broken,BAD,TQ9999999999,12,GSM,900,20,30,,not-lat,-0.2`;

describe('Sitefinder parser', () => {
  test('parses representative rows and drops invalid coordinates', () => {
    const payload = parseSitefinderCsv(CSV);

    expect(payload.totalRows).toBe(4);
    expect(payload.validRows).toBe(3);
    expect(payload.transmissions).toHaveLength(3);
    expect(payload.sites).toHaveLength(2);
  });

  test('groups physical rows with the same op ref and site NGR', () => {
    const payload = parseSitefinderCsv(CSV);
    const site = payload.sites.find((item) => item.opref === 'ATN0051');

    expect(site?.transmissionCount).toBe(2);
    expect(site?.transmissionTypes).toEqual(['GSM', 'UMTS']);
    expect(site?.minAntennaHeightMeters).toBe(20);
    expect(site?.maxAntennaHeightMeters).toBe(21);
  });

  test('corrects the OSGB36 CSV coordinates to WGS84 (matches the pipeline frame)', () => {
    const payload = parseSitefinderCsv(CSV);
    const site = payload.sites.find((item) => item.opref === 'ATN0051');

    // The CSV lat/lng are OSGB36 geodetic; src/masts.py now applies the same
    // OSGB36→WGS84 datum shift at the source, so the parser must too — otherwise the
    // served masts sit ~125 m off the pipeline's rays/masts. These are the
    // OSGB36→WGS84 transform of the raw (51.46557, -0.095904). See
    // correctSitefinderLatLng in lib/geo/datasetCoordinates.ts.
    expect(site?.lat).toBeCloseTo(51.466078, 4);
    expect(site?.lng).toBeCloseTo(-0.097512, 4);
    // the datum shift is a real ~125 m move, not a no-op
    expect(site?.lat).not.toBeCloseTo(51.46557, 4);
  });

  test('handles blank power fields and unknown transmission types', () => {
    const payload = parseSitefinderCsv(CSV);
    const unknown = payload.transmissions.find((transmission) => transmission.opref === 'VF001');

    expect(unknown?.transmissionType).toBe('UNKNOWN');
    expect(unknown?.antennaHeightMeters).toBeNull();
    expect(unknown?.maxPowerDbm).toBeNull();
  });

  test('filters by operator, transmission type, and limit', () => {
    const payload = parseSitefinderCsv(CSV);
    const filtered = filterSitefinderPayload(payload, { operator: 'Orange', transtype: 'UMTS', limit: 1 });

    expect(filtered.sites).toHaveLength(1);
    expect(filtered.sites[0].operator).toBe('Orange');
    expect(filtered.sites[0].transmissionTypes).toContain('UMTS');
  });
});

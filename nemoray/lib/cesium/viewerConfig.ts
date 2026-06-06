import * as Cesium from 'cesium';

// Scene origin: The Shard, London Bridge (51.5045 N, 0.0865 W).
export const SHARD_LNG = -0.0865;
export const SHARD_LAT = 51.5045;

// Land the camera *beside* the Shard, not on it — the tower is ~310 m tall, so
// spawning at its coordinates puts you inside it. Sit south-south-east of it at
// 280 m altitude; the heading (-20°, facing NNW) then points straight at the
// tower so it reads in front of you, framed against the cityscape.
export const LONDON_POSITION = Cesium.Cartesian3.fromDegrees(
  SHARD_LNG + 0.0023,
  SHARD_LAT - 0.004,
  280
);

export const LONDON_HEADING = Cesium.Math.toRadians(-20);

/**
 * Default landing pitch — a shallow, slanted oblique so building facades read in
 * 3D (closer to the horizon than a steep top-down). Shared by the initial view,
 * the reset shot, and the "3D" tilt toggle.
 */
export const OBLIQUE_PITCH = Cesium.Math.toRadians(-24);

export const INITIAL_CAMERA = {
  destination: LONDON_POSITION,
  orientation: {
    heading: LONDON_HEADING,
    pitch: OBLIQUE_PITCH,
    roll: 0,
  },
};

/**
 * Far whole-Earth view the camera starts on, so the intro flight reads as a
 * dramatic zoom-in from the globe down to London. The world model is now the
 * dark untextured globe (the OSM twin's z = 0 ground), so this far view renders
 * as a dim Earth that resolves into the glowing OSM city + coverage on descent.
 */
export const GLOBE_CAMERA = {
  destination: Cesium.Cartesian3.fromDegrees(SHARD_LNG, SHARD_LAT, 20_000_000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-90),
    roll: 0,
  },
};

// Zoom band for the city scene. The minimum stops the camera clipping through
// the OSM buildings; the maximum keeps the user over the simulated London extent
// so they don't pull back to where there's only bare dark globe. A future orbital
// "space mode" would raise MAX_ZOOM_M.
export const MIN_ZOOM_M = 30;
export const MAX_ZOOM_M = 9000;

export const NIGHT_SCENE_SETTINGS = {
  ambientOcclusionEnabled: true,
  bloomEnabled: true,
  bloomGlowOnly: false,
  bloomBrightness: 0.3,
  bloomIntensity: 2.0,
  sunLight: false,
  moonLight: false,
  skyAtmosphere: false,
  backgroundColor: Cesium.Color.fromCssColorString('#030a18'),
};

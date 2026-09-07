/* Whispering Meadow - geom.js
   Extracted from the original single file. Logic unchanged. */

import { BROOK, BROOK_BB, POOL, RIVER, RIVER_BB, clamp, pathFar, pathInfo, terrainHeight } from './core.js';
function GB() { this.p = []; this.n = []; this.c = []; this.i = []; }
GB.prototype.add = function (geo, mtx, col, jitter, rng) {
  var pos = geo.attributes.position, nor = geo.attributes.normal;
  var base = this.p.length / 3;
  var nm = new THREE.Matrix3().getNormalMatrix(mtx);
  var v = new THREE.Vector3();
  for (var k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(mtx);
    this.p.push(v.x, v.y, v.z);
    if (nor) { v.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize(); this.n.push(v.x, v.y, v.z); }
    else { this.n.push(0, 1, 0); }
    var j = jitter ? (rng() - 0.5) * jitter : 0;
    this.c.push(clamp(col.r + j, 0, 1), clamp(col.g + j, 0, 1), clamp(col.b + j, 0, 1));
  }
  var id = geo.index;
  if (id) { for (k = 0; k < id.count; k++) { this.i.push(base + id.getX(k)); } }
  else { for (k = 0; k < pos.count; k++) { this.i.push(base + k); } }
  return this;
};
GB.prototype.build = function () {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
  g.setIndex(this.i);
  g.computeBoundingSphere();
  return g;
};

function M4(x, y, z, rx, ry, rz, sx, sy, sz) {
  var m = new THREE.Matrix4();
  var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, 'YXZ'));
  m.compose(new THREE.Vector3(x || 0, y || 0, z || 0), q,
    new THREE.Vector3(sx === undefined ? 1 : sx, sy === undefined ? (sx === undefined ? 1 : sx) : sy,
      sz === undefined ? (sx === undefined ? 1 : sx) : sz));
  return m;
}

/* the "definitely nowhere near it" answers, allocated once so the hot path
   below never builds a throwaway object */
var RIVER_FAR = { d: 1e9, y: 0 }, BROOK_FAR = { d: 1e9, y: 0 };

function siteInfo(x, z) {
  var h = terrainHeight(x, z);
  var e = 2.5;
  var dx = terrainHeight(x + e, z) - h, dz = terrainHeight(x, z + e) - h;
  var slope = Math.sqrt(dx * dx + dz * dz) / e;
  /* Every consumer of riverD compares it against a threshold of 42 or less
     (see props.js: <26, <24, 22..40, 12..42) and bi is only ever read as
     `< 12`, so once the bounding box proves the point is more than 200 away
     from the spine the exact figure cannot change any decision. Skipping the
     walk there is behaviour-preserving, and it is the difference between two
     polyline sweeps per site test and none for most of the map. */
  var ri = pathFar(RIVER_BB, x, z, 200) ? RIVER_FAR : pathInfo(RIVER, x, z);
  var bi = pathFar(BROOK_BB, x, z, 200) ? BROOK_FAR : pathInfo(BROOK, x, z);
  var pdx = x - POOL.x, pdz = z - POOL.z;
  var pd = Math.sqrt(pdx * pdx + pdz * pdz);
  var inWater = (ri.d < 30 && h < ri.y + 0.4 && z > -360 && z < 470) ||
    (bi.d < 12 && h < bi.y + 0.4) || (pd < POOL.r && h < 14.4) || h < 0.4;
  return { h: h, slope: slope, riverD: ri.d, poolD: pd, water: inWater };
}

export { GB, M4, siteInfo };

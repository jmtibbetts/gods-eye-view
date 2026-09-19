// src/data/issPass.js
/**
 * The ISS pass finder, kept at its old address. The general predictor lives
 * in satellitePass.js and works for any satellite with elements; the ISS
 * was simply the first one asked about.
 */
export { findNextIssPass, lookAnglesAt } from './satellitePass.js';

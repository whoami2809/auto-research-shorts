'use strict';
const { editorial } = require('./editorial');
const { voice } = require('./voice');
function createProviders({ env = process.env, fetchImpl = fetch } = {}) {
  return { roteiro: editorial('roteiro', env, fetchImpl), titulos: editorial('titulos', env, fetchImpl), seo: editorial('seo', env, fetchImpl), voz: voice(env) };
}
module.exports = { createProviders };

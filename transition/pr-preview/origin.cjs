'use strict';

const previewOrigin = /^https:\/\/ygo-synapse--pr-[1-9]\d*-[a-z0-9]+\.web\.app$/;

function allowsPrPreviewOrigin(origin, config, sampleInventoryConfigured) {
  return config.environment === 'preview' && config.mode === 'demo'
    && sampleInventoryConfigured && previewOrigin.test(origin);
}

module.exports = { allowsPrPreviewOrigin };

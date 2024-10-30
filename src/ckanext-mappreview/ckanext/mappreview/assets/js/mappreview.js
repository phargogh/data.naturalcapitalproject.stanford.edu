ckan.module("mappreview", function ($, _) {
  "use strict";
  return {
    options: {
      config: {},
      globalConfig: {},
      debug: false,
      titilerUrl: 'https://titiler-897938321824.us-west1.run.app',
    },

    _getGlobalConfig: function () {
      return JSON.parse(this.options.globalConfig.replace(/'/g, '"'));
    },

    _getRasterTilejsonUrl: function (layer) {
      const base = this._getGlobalConfig().titiler_url;
      const endpoint = '/cog/WebMercatorQuad/tilejson.json';
      const params = {
        tile_scale: 2,
        url: layer.url,
        bidx: 1,
        colormap_name: 'blues',
        // rescale: '355,5000',
        // TODO use q98?
        // rescale: `${layer.pixel_min_value},${layer.pixel_max_value}`,
        rescale: `${layer.pixel_percentile_2},${layer.pixel_percentile_98}`,
      };

      const paramsPrepared = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      return `${base}${endpoint}?${paramsPrepared}`;
    },

    initialize: function () {
      jQuery.proxyAll(this, '_getGlobalConfig');
      jQuery.proxyAll(this, '_getRasterTilejsonUrl');

      const config = JSON.parse(this.options.config.replace(/'/g, '"'));
      const globalConfig = this._getGlobalConfig();

      mapboxgl.accessToken = globalConfig.mapbox_api_key;
      const map = new mapboxgl.Map({
        container: 'map',
        style: globalConfig.mapbox_style,
        bounds: config.map.bounds,
        minZoom: config.map.minzoom,
        maxZoom: config.map.maxzoom,
      });

      const sources = config.layers.map(l => {
        if (l.type === 'raster') {
          const url = this._getRasterTilejsonUrl(l);
          return {
            id: l.name,
            type: 'raster',
            url,
          };
        }
      });

      const layers = config.layers.map(l => {
        if (l.type === 'raster') {
          return {
            id: l.name,
            type: 'raster',
            source: l.name,
          };
        }
      });

      map.on('load', () => {
        sources.forEach((source) => {
          map.addSource(source.id, source);
        });

        layers.forEach((layer) => {
          map.addLayer(layer);
        });

        const targets = Object.fromEntries(config.layers.map(l => [l.name, l.name]));

        map.addControl(new MapboxLegendControl(targets, {
          showDefault: false, 
          showCheckbox: true, 
          onlyRendered: false,
          reverseOrder: true
        }), 'top-right');
      });

      // TODO only for vector layers?
      map.on('click', sources.map(s => s.id), (e) => {
        let content = '';

        e.features.forEach(f => {
          content += `<h3>${f.layer.id}</h3>
            <ul>
            ${Object.keys(f.properties).map(k => `<li>${k}: ${f.properties[k]}</li>`).join('')}
          </ul>`;
        });

        const popup = new mapboxgl.Popup({ className: 'mappreview-mapboxgl-popup' })
          .setLngLat(e.lngLat)
          .setMaxWidth("300px")
          .setHTML(content)
          .addTo(map);
      });
    },
  };
});

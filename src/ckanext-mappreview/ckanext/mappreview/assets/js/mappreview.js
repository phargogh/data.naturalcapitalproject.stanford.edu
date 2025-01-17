ckan.module("mappreview", function ($, _) {
  "use strict";
  return {
    options: {
      config: {},
      globalConfig: {},
      debug: false,
    },

    vectorColors: [
      '#E04F39',
      '#F9A44A',
      '#FEC51D',
      '#A57DAE',
    ],

    /**
     * Linear scale pixel values to [0, 255] range
     */
    _getColorMapValue: function (min, max, value) {
      if (value <= min) return 0;
      if (value >= max) return 255;
      return Math.round(((value - min) / (max - min)) * 255);
    },

    _getGlobalConfig: function () {
      return JSON.parse(this.options.globalConfig.replace(/'/g, '"'));
    },

    _getRasterPoint: async function (layer, lngLat) {
      const response = await fetch(`${this._getGlobalConfig().titiler_url}/cog/point/${lngLat.lng},${lngLat.lat}?url=${encodeURIComponent(layer.url)}`);
      return (await response.json());
    },

    _getRasterTilejsonUrl: function (layer) {
      const base = this._getGlobalConfig().titiler_url;
      const endpoint = '/cog/WebMercatorQuad/tilejson.json';

      const colors = [
        [75, 171, 57, 50], // #4BAB39
        [0, 143, 95, 255], // #008F5F
        [0, 100, 110, 255], // #00646E
        [28, 58, 109, 255], // #1C3A6D
        [32, 40, 93, 255], // #20285D
        [39, 0, 59, 255], // #27003B
      ];

      const colormap = {};

      const percentiles = [2, 20, 40, 60, 80, 98];
      percentiles.forEach((percentile, i) => {
        let colorIndex = this._getColorMapValue(layer.pixel_min_value, layer.pixel_max_value, layer[`pixel_percentile_${percentile}`]);

        // Color map must start with 0 and end with 255
        if (i === 0) colorIndex = 0;
        if (i === percentiles.length - 1) colorIndex = 255;

        colormap[colorIndex] = colors[i];
      });

      const params = {
        tile_scale: 2,
        url: layer.url,
        bidx: 1,
        format: 'webp',
        rescale: `${layer.pixel_percentile_2},${layer.pixel_percentile_98}`,
        colormap: JSON.stringify(colormap),
        colormap_type: 'linear',
      };

      const paramsPrepared = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      return `${base}${endpoint}?${paramsPrepared}`;
    },

    _getRasterLayer: function (layer) {
      return {
        id: layer.name,
        type: 'raster',
        source: layer.name,
        paint: {
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 12, 1],
        },
      };
    },

    _getVectorLayers: function (layer, index) {
      const color = this.vectorColors[index % this.vectorColors.length];

      if (layer.vector_type === 'Point') {
        return {
          id: layer.name,
          type: 'circle',
          source: layer.name,
          paint: {
            'circle-radius': 5,
            'circle-color': color,
          }
        };
      }
      else if (layer.vector_type === 'Line') {
        return {
          id: layer.name,
          type: 'line',
          source: layer.name,
          paint: {
            'line-width': 5,
            'line-color': color,
          }
        };
      }
      else if (layer.vector_type === 'Polygon') {
        return [
          {
            id: `${layer.name}-outline`,
            type: 'line',
            source: layer.name,
            paint: {
              'line-width': 2,
              'line-color': color,
            }
          },
          {
            id: layer.name,
            type: 'fill',
            source: layer.name,
            paint: {
              'fill-color': color,
              'fill-opacity': 0.5
            }
          }
        ];
      }
    },

    initialize: function () {
      jQuery.proxyAll(this, '_getGlobalConfig');
      jQuery.proxyAll(this, '_getRasterLayer');
      jQuery.proxyAll(this, '_getRasterTilejsonUrl');
      jQuery.proxyAll(this, '_getRasterPoint');
      jQuery.proxyAll(this, '_getVectorLayers');

      const config = JSON.parse(this.options.config.replace(/'/g, '"'));
      const globalConfig = this._getGlobalConfig();

      mapboxgl.accessToken = globalConfig.mapbox_api_key;
      const map = new mapboxgl.Map({
        container: 'map',
        style: globalConfig.mapbox_style,
        bounds: config.map.bounds,
        zoom: config.map.minzoom + 2,
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
        else if (l.type === 'vector') {
          return {
            id: l.name,
            type: 'geojson',
            data: l.url,
          };
        }
        else {
          console.warn(`Unsupported source type: ${l.type}`);
          return null;
        }
      });

      const layers = config.layers
        .map((l, i) => {
          if (l.type === 'raster') {
            return this._getRasterLayer(l);
          }
          else if (l.type === 'vector') {
            return this._getVectorLayers(l, i);
          }
          else {
            console.warn(`Unsupported layer type: ${l.type}`);
            return null;
          }
        })
        .filter(l => l !== null)
        .flat()
        .toSorted((a, b) => {
          const order = ['raster', 'fill', 'line', 'circle'];
          return order.indexOf(a.type) - order.indexOf(b.type);
        });

      map.on('load', () => {
        sources.forEach((source) => {
          // Avoid warning about id
          const cleanSource = Object.fromEntries(Object.entries(source).filter(([k, v]) => k !== 'id'));
          map.addSource(source.id, cleanSource);
        });

        layers.forEach((layer) => {
          map.addLayer(layer);
        });

        const targets = Object.fromEntries(config.layers.map(l => [l.name, l.name]));

        map.addControl(new MapboxLegendControl(targets, {
          showDefault: true, 
          showCheckbox: true, 
          onlyRendered: false,
          reverseOrder: true
        }), 'top-right');
      });

      map.on('click', async (e) => {
        let popupContent;

        const vectorLayers = layers.filter(s => s.type !== 'raster');
        if (vectorLayers.length > 0) {
          const vectorFeature = map.queryRenderedFeatures(e.point, { layers: vectorLayers.map(l => l.id) })[0];

          if (vectorFeature) {
            const rows = Object.entries(vectorFeature.properties)
              .map(([key, value]) => `
                <div class="popup-key">${key}</div>
                <div class="popup-value">${value}</div>
              `);

            popupContent = `<h3>${config.layers[0].name}</h3>
              <div class="popup-grid">
                ${rows.join('')}
              </div>`;
          }
        }

        if (!popupContent && (config.layers.length === 1 && config.layers[0].type === 'raster')) {
          const point = await this._getRasterPoint(config.layers[0], e.lngLat);
          if (!point) return;

          popupContent = `<h3>${config.layers[0].name}</h3>
            <div class="popup-grid">
                <div class="popup-key">value</div>
                <div class="popup-value">${point.values[0]}</div>
            </div>`;
        }

        if (popupContent) {
          const popup = new mapboxgl.Popup({ className: 'mappreview-mapboxgl-popup' })
            .setLngLat(e.lngLat)
            .setMaxWidth("300px")
            .setHTML(popupContent)
            .addTo(map);
        }
      });
    },
  };
});

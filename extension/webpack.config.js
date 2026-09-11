const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: {
      content:    './src/content/content.ts',
      background: './src/background/service-worker.ts',
      popup:      './src/popup/index.tsx',
      offscreen:  './src/offscreen/offscreen-entry.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      publicPath: '',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      fallback: {
        // Node polyfills not needed in browser
        fs: false, path: false, crypto: false,
      }
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'src/popup/popup.html', to: 'popup.html' },
          { from: 'src/offscreen/ocr.html', to: 'offscreen.html' },
          { from: 'icons', to: 'icons', noErrorOnMissing: true },
          { from: 'models', to: 'models', noErrorOnMissing: true },
          // ONNX Runtime Web WASM and JS/MJS loader files — needed by YOLOS-Tiny.
          {
            from: 'node_modules/onnxruntime-web/dist',
            to: 'ort-wasm',
            filter: async (resourcePath) => path.basename(resourcePath).startsWith('ort-wasm'),
            noErrorOnMissing: true,
          },
          {
            from: 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
            to: 'ort-wasm',
            filter: async (resourcePath) => path.basename(resourcePath).startsWith('ort-wasm'),
            noErrorOnMissing: true,
          },
        ],
      }),
    ],
    devtool: isDev ? 'inline-source-map' : false,
    optimization: {
      // Keep extension scripts in single files (no code splitting)
      runtimeChunk: false,
      splitChunks: false,
    },
  };
};

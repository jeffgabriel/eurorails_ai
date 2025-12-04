const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry: './src/client/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/client'),
    filename: '[name].[contenthash].js',
    publicPath: '/',
    clean: true,
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        phaser: {
          test: /[\\/]node_modules[\\/]phaser[\\/]/,
          name: 'phaser',
          chunks: 'all',
          priority: 20,
          enforce: true,
        },
        vendor: {
          test: /[\\/]node_modules[\\/](?!phaser)[\\/]/,
          name: 'vendors',
          chunks: 'all',
          priority: 10,
        },
      },
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: [
          /node_modules/,
          /src\/client_backup_/
        ],
        options: {
          configFile: 'tsconfig.webpack.json',
          transpileOnly: true,
          experimentalWatchApi: true
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
      {
        test: /\.(png|svg|jpg|jpeg|gif)$/i,
        type: 'asset/resource',
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/client/index.html',
      favicon: './public/favicon.png',
    }),
    new webpack.DefinePlugin({
      'process.env.REACT_APP_MOCK_MODE': JSON.stringify(process.env.REACT_APP_MOCK_MODE || 'false'),
      'process.env.REACT_APP_DEV_AUTH': JSON.stringify(process.env.REACT_APP_DEV_AUTH || 'false'),
      'process.env.VITE_API_BASE_URL': JSON.stringify(process.env.VITE_API_BASE_URL || 'http://localhost:3001'),
      'process.env.VITE_SOCKET_URL': JSON.stringify(process.env.VITE_SOCKET_URL || 'http://localhost:3001'),
      'process.env.VITE_DEBUG': JSON.stringify(process.env.VITE_DEBUG || 'false'),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    }),
    // Debug plugin to log what values webpack is using
    new (class {
      apply(compiler) {
        compiler.hooks.beforeRun.tap('DebugEnvPlugin', () => {
          console.log('=========================================');
          console.log('WEBPACK BUILD - ENVIRONMENT VARIABLES:');
          console.log('VITE_API_BASE_URL:', process.env.VITE_API_BASE_URL || '(not set, will use default: http://localhost:3001)');
          console.log('VITE_SOCKET_URL:', process.env.VITE_SOCKET_URL || '(not set, will use default: http://localhost:3001)');
          console.log('VITE_DEBUG:', process.env.VITE_DEBUG || '(not set, will use default: false)');
          console.log('NODE_ENV:', process.env.NODE_ENV || '(not set, will use default: development)');
          console.log('=========================================');
        });
      }
    })(),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'),
    },
    compress: true,
    port: 3000,
    hot: true,
    liveReload: true,
    watchFiles: ['src/**/*'],
    historyApiFallback: {
      index: '/',
      rewrites: [
        { from: /^\/lobby/, to: '/' },
        { from: /^\/login/, to: '/' },
        { from: /^\/register/, to: '/' },
        { from: /^\/game\/.*/, to: '/' }
      ]
    },
    proxy: [
      {
        context: ['/api'],
        target: 'http://localhost:3001',
        secure: false,
        changeOrigin: true,
        pathRewrite: { '^/api': '/api' }
      },
      {
        context: ['/socket.io'],
        target: 'http://localhost:3001',
        secure: false,
        changeOrigin: true,
        ws: true
      }
    ]
  },
  devtool: 'eval-cheap-module-source-map',
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
}; 
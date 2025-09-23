const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/client/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/client'),
    filename: '[name].[contenthash].js',
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
          test: /[\\/]node_modules[\\/]/,
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
          configFile: 'tsconfig.webpack.json'
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
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'),
    },
    compress: true,
    port: 3000,
    hot: true,
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
  devtool: 'eval-source-map',
}; 
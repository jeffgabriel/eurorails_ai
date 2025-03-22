import path from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  entry: './src/client/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist/client'),
    filename: 'bundle.js',
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
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
      publicPath: '/'
    },
    compress: true,
    port: 3000,
    hot: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        secure: false,
        changeOrigin: true,
        pathRewrite: { '^/api': '/api' },
        onError: (err, req, res) => {
          console.error('Proxy error:', err);
          res.writeHead(500, {
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
        },
        onProxyReq: (proxyReq, req, res) => {
          console.log(`Proxying ${req.method} ${req.url} to ${proxyReq.path}`);
        }
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        secure: false,
        changeOrigin: true,
        ws: true
      }
    }
  },
}; 
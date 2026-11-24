import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { ephemeralListenCallback } from './setupLoopbackListen';

describe('setupLoopbackListen', () => {
  const callback = (): void => undefined;

  describe('ephemeralListenCallback', () => {
    it('recognises host-less listens on an OS-assigned port', () => {
      expect(ephemeralListenCallback([])).toBeNull();
      expect(ephemeralListenCallback([0])).toBeNull();
      expect(ephemeralListenCallback([callback])).toBe(callback);
      expect(ephemeralListenCallback([0, callback])).toBe(callback);
    });

    it('leaves calls that name a host, a fixed port, a pipe or options alone', () => {
      const untouched: unknown[][] = [
        [3001],
        [3001, callback],
        [0, '0.0.0.0', callback],
        [0, 511, callback],
        ['/tmp/test.sock'],
        [{ port: 0 }],
        [{ path: '/tmp/test.sock' }],
      ];
      for (const args of untouched) {
        expect(ephemeralListenCallback(args)).toBeUndefined();
      }
    });
  });

  it('binds listen(0) to 127.0.0.1 synchronously, as supertest requires', () => {
    const server = http.createServer();
    server.listen(0);
    try {
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect(address.port).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('binds a plain listen() to 127.0.0.1', async () => {
    const server = http.createServer();
    await new Promise<void>(resolve => { server.listen(resolve); });
    try {
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });

  it('keeps supertest requests working', async () => {
    const app = express();
    app.get('/ping', (_req, res) => { res.status(204).end(); });

    await request(app).get('/ping').expect(204);
  });
});

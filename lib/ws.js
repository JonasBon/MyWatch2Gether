'use strict';
/*
 * Minimaler WebSocket-Server (RFC 6455) ohne externe Pakete.
 * Unterstützt Text-Nachrichten, Fragmentierung, Ping/Pong und Close.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 512 * 1024;

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = null;
    this.fragOp = 0;
    this.fragSize = 0;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (e) { /* schon zu */ }
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002); // Clients müssen maskieren
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
      this.buf = buf.subarray(off + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    switch (op) {
      case 0x0: // Fortsetzung
        if (!this.frags) return this.close(1002);
        this.frags.push(payload);
        this.fragSize += payload.length;
        if (this.fragSize > MAX_PAYLOAD) return this.close(1009);
        if (fin) {
          const data = Buffer.concat(this.frags);
          const o = this.fragOp;
          this.frags = null;
          this._message(o, data);
        }
        return;
      case 0x1:
      case 0x2:
        if (this.frags) return this.close(1002);
        if (fin) this._message(op, payload);
        else {
          this.frags = [payload];
          this.fragOp = op;
          this.fragSize = payload.length;
        }
        return;
      case 0x8: { // Close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code >= 1000 && code < 5000 ? code : 1000);
        this._send(0x8, b);
        try { this.socket.end(); } catch (e) { /* egal */ }
        this._closed();
        return;
      }
      case 0x9: // Ping
        this._send(0xA, payload);
        return;
      case 0xA: // Pong
        this.alive = true;
        return;
      default:
        this.close(1002);
    }
  }

  _message(op, data) {
    if (op === 0x1) this.emit('message', data.toString('utf8'));
  }

  _send(op, data) {
    if (!this.open || this.socket.destroyed) return;
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch (e) {
      this._closed();
    }
  }

  send(str) {
    this._send(0x1, Buffer.from(str, 'utf8'));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    this._send(0x8, b);
    try { this.socket.end(); } catch (e) { /* egal */ }
    this._closed();
  }
}

function handleUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '', ''
  ].join('\r\n'));
  const ws = new WebSocketConnection(socket);
  onConnection(ws, req);
  if (head && head.length) ws._onData(head);
}

module.exports = { handleUpgrade };

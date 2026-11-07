'use strict';

/** Keep an API response private until the datastore transaction commits. */
class HttpBuffer {
  constructor() { this.statusCode = 200; this.headers = new Map(); this.parts = []; this.finished = false; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  write(value) { if (value != null) this.parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); return true; }
  end(value) { this.write(value); this.finished = true; return this; }
  flush(res) {
    if (!this.finished) throw new Error('API handler did not finish its response');
    res.writeHead(this.statusCode, Object.fromEntries(this.headers));
    res.end(Buffer.concat(this.parts));
  }
}

module.exports = { HttpBuffer };

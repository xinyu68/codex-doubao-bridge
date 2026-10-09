const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function encodeFrame(body, opcode = 1) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

export class FrameDecoder {
  constructor(onText, onControl = () => {}) {
    this.onText = onText;
    this.onControl = onControl;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const bytes = this.buffer;
      const final = Boolean(bytes[0] & 0x80);
      const opcode = bytes[0] & 0x0f;
      if (bytes[0] & 0x70) throw new Error("Unsupported WebSocket extension bits");
      if (!(bytes[1] & 0x80)) throw new Error("Client frames must be masked");
      let size = bytes[1] & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (bytes.length < 4) return;
        size = bytes.readUInt16BE(2);
        offset = 4;
      } else if (size === 127) {
        if (bytes.length < 10) return;
        const largeSize = bytes.readBigUInt64BE(2);
        if (largeSize > BigInt(MAX_MESSAGE_BYTES)) throw new Error("WebSocket message too large");
        size = Number(largeSize);
        offset = 10;
      }
      if (size > MAX_MESSAGE_BYTES || this.fragmentBytes + size > MAX_MESSAGE_BYTES) throw new Error("WebSocket message too large");
      if (opcode >= 8 && (!final || size > 125)) throw new Error("Invalid control frame");
      const end = offset + 4 + size;
      if (bytes.length < end) return;
      const mask = bytes.subarray(offset, offset + 4);
      const data = Buffer.from(bytes.subarray(offset + 4, end));
      for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
      this.buffer = bytes.subarray(end);
      if (opcode >= 8) {
        this.onControl(opcode, data);
        continue;
      }
      if (opcode === 1) {
        if (this.fragments.length) throw new Error("Unexpected new text frame");
      } else if (opcode !== 0 || !this.fragments.length) throw new Error("Unexpected WebSocket continuation");
      this.fragments.push(data);
      this.fragmentBytes += size;
      if (final) {
        this.onText(Buffer.concat(this.fragments));
        this.fragments = [];
        this.fragmentBytes = 0;
      }
    }
  }
}

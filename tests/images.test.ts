import { describe, it, expect } from 'vitest';
import { sniffImage, displaySize } from '../src/api/images.js';

describe('sniffImage', () => {
  it('PNG 尺寸（IHDR）', () => {
    const b = new Uint8Array(32);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
    b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    b[18] = 0x01; // width = 0x00000100 = 256
    b[23] = 0xc8; // height = 0x000000C8 = 200
    expect(sniffImage(b)).toEqual({ mime: 'image/png', width: 256, height: 200 });
  });

  it('GIF 尺寸（小端）', () => {
    const b = new Uint8Array(13);
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
    b[6] = 0x10; b[7] = 0x01; // 272
    b[8] = 0xE0; b[9] = 0x00; // 224
    expect(sniffImage(b)).toEqual({ mime: 'image/gif', width: 272, height: 224 });
  });

  it('JPEG 尺寸（SOF0 扫描）', () => {
    const b = new Uint8Array(40);
    b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
    // APP0 段填充到偏移 20
    for (let i = 6; i < 20; i++) b[i] = 0;
    // SOF0
    b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
    b[25] = 0x01; b[26] = 0x2c; // height 300
    b[27] = 0x00; b[28] = 0x64; // width 100
    expect(sniffImage(b)).toEqual({ mime: 'image/jpeg', height: 300, width: 100 });
  });

  it('BMP 尺寸', () => {
    const b = new Uint8Array(30);
    b[0] = 0x42; b[1] = 0x4d;
    const dv = new DataView(b.buffer);
    dv.setInt32(18, 640, true);
    dv.setInt32(22, 480, true);
    expect(sniffImage(b)).toEqual({ mime: 'image/bmp', width: 640, height: 480 });
  });

  it('SVG 文本识别（无尺寸）', () => {
    const b = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="..."></svg>');
    expect(sniffImage(b)).toEqual({ mime: 'image/svg+xml' });
  });

  it('未知内容返回 null', () => {
    expect(sniffImage(new TextEncoder().encode('hello world'))).toBeNull();
  });
});

describe('displaySize', () => {
  it('小图原样返回', () => {
    expect(displaySize(100, 50)).toEqual({ width: 100, height: 50 });
  });
  it('大图等比缩放到最大宽度', () => {
    expect(displaySize(1000, 500)).toEqual({ width: 780, height: 390 });
  });
  it('缺尺寸返回 undefined', () => {
    expect(displaySize(undefined, 100)).toBeUndefined();
  });
});

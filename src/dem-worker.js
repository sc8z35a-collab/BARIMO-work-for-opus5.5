// DEM decode worker: PNG blob → cleaned Float32 heights (transferred back zero-copy).
import { decodeBlob } from './dem-decode.js';

self.onmessage = async (e) => {
  const { id, blob, kind, lo, hi } = e.data;
  try {
    const r = await decodeBlob(blob, kind, lo, hi);
    self.postMessage({ id, ok: true, ...r }, [r.h.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
